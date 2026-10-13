import "server-only"

/**
 * 知识库后台任务处理器。
 *
 * 解析任务生成 Markdown，RECHUNK 任务分块、向量化并写入索引。
 * 事务和任务租约共同保护文档版本与任务状态。
 */

import { createHash, randomUUID } from "node:crypto"
import type {
  DocumentProcessingJobType,
  KnowledgeDocumentType,
  Prisma,
} from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import {
  registerCleanupJobs,
  registerRechunkJob,
} from "@/lib/knowledge/management/service"
import {
  lockOwnedKnowledgeBase,
  type KnowledgeTransaction,
} from "@/lib/knowledge/ownership"
import { chunkMarkdown } from "@/lib/knowledge/indexing/chunk"
import { embedDocumentChunks } from "@/lib/knowledge/indexing/embedding"
import { replaceDocumentChunks } from "@/lib/knowledge/indexing/indexing"
import {
  deleteKnowledgeChunks,
  indexKnowledgeChunks,
} from "@/lib/es/knowledge-index"
import {
  MAX_DOCUMENT_PARSE_TIME_MS as MAX_PARSE_TIME_MS,
  DOCUMENT_JOB_LEASE_MS as JOB_LEASE_MS,
} from "@/lib/knowledge/jobs/lease"
import {
  getKnowledgeAssetNames,
  getKnowledgeAssetStorageKey,
  getKnowledgeAssetUrl,
} from "@/lib/knowledge/documents/assets"
import { getKnowledgeParser } from "@/lib/knowledge/parsers/registry"
import {
  KnowledgeParseError,
  type KnowledgeSourceKind,
  type ParsedSection,
} from "@/lib/knowledge/parsers/types"
import { deleteOssObject, getOssObject, putOssObject } from "@/lib/storage/oss"

const transactionOptions = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5_000,
  // 远端数据库的锁检查和分块写入可能超过 10 秒；外部 API 始终在事务外执行。
  timeout: 30_000,
}

// 处理阶段只需要这些已领取任务字段。
type ClaimedJob = {
  id: string
  documentId: string | null
  type: DocumentProcessingJobType
  payload: Prisma.JsonValue
  attempts: number
  maxAttempts: number
  lockToken: string
  targetRevision: number | null
  lockedUntil: Date
}

const toJson = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

const claimNextJob = async (): Promise<ClaimedJob | null> => {
  const now = new Date()
  // 新任务可以直接领取；运行中的任务只有租约过期后才能被接管。
  const candidate = await prisma.documentProcessingJob.findFirst({
    where: {
      OR: [
        { status: "PENDING", availableAt: { lte: now } },
        { status: "RUNNING", lockedUntil: { lt: now } },
      ],
      type: { in: ["PARSE", "REPARSE", "RECHUNK", "CLEANUP"] },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      documentId: true,
      type: true,
      status: true,
      payload: true,
      attempts: true,
      maxAttempts: true,
      lockedUntil: true,
      targetRevision: true,
    },
  })
  if (!candidate) return null

  // lockToken 是本次领取的凭证，之后的状态更新必须同时匹配它。
  const lockToken = randomUUID()
  const lockedUntil = new Date(now.getTime() + JOB_LEASE_MS)
  // 更新条件包含旧状态，多个 Worker 竞争时只有一个能够领取成功。
  const claimed = await prisma.documentProcessingJob.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      ...(candidate.status === "RUNNING"
        ? { lockedUntil: candidate.lockedUntil }
        : { availableAt: { lte: now } }),
    },
    data: {
      status: "RUNNING",
      attempts: { increment: 1 },
      lockedAt: now,
      lockedUntil,
      lockToken,
      lastError: null,
    },
  })
  if (claimed.count !== 1) return null

  // 领取成功后同步文档状态，前端可以及时显示“解析中”。
  // 分块和清理不属于解析，正文状态保持独立。
  if (
    candidate.documentId &&
    (candidate.type === "PARSE" || candidate.type === "REPARSE")
  ) {
    await prisma.knowledgeDocument.updateMany({
      where: { id: candidate.documentId, deletedAt: null },
      data: {
        status: "PARSING",
        parseErrorCode: null,
        parseErrorMessage: null,
      },
    })
  }

  return {
    id: candidate.id,
    documentId: candidate.documentId,
    type: candidate.type,
    payload: candidate.payload,
    attempts: candidate.attempts + 1,
    maxAttempts: candidate.maxAttempts,
    lockToken,
    targetRevision: candidate.targetRevision,
    lockedUntil,
  }
}

const completeCleanupJob = async (job: ClaimedJob) => {
  // JSON 来自持久化任务，必须确认对象键有效后才能执行删除。
  const payload = job.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("文档清理任务 payload 无效")
  }
  if (payload.target === "elasticsearch") {
    if (typeof payload.documentId !== "string" || !payload.documentId) {
      throw new Error("ES 清理任务缺少 documentId")
    }
    await deleteKnowledgeChunks(payload.documentId)
  } else {
    if (typeof payload.storageKey !== "string" || !payload.storageKey) {
      throw new Error("文档任务缺少 storageKey")
    }
    await deleteOssObject(payload.storageKey)
  }
  await prisma.documentProcessingJob.deleteMany({
    where: { id: job.id, status: "RUNNING", lockToken: job.lockToken },
  })
}

// 数据库文档类型与解析器输入类型的对应关系。
const documentKinds: Record<KnowledgeDocumentType, KnowledgeSourceKind> = {
  PDF: "pdf",
  DOCX: "docx",
  MARKDOWN: "markdown",
  TEXT: "txt",
}

const withTimeout = async <T>(promise: Promise<T>, milliseconds: number) => {
  // 限制 Worker 等待解析结果的时间，防止一个任务长期占用租约。
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new KnowledgeParseError(
                "PARSE_TIMEOUT",
                "文档解析超时，请拆分文件后重试",
                413,
                true
              )
            ),
          milliseconds
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const processParseJob = async (job: ClaimedJob) => {
  if (!job.documentId) throw new Error("解析任务缺少 documentId")
  // 任务排队期间文档可能被删除，因此开始处理时重新查询一次。
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id: job.documentId, deletedAt: null },
    select: {
      id: true,
      knowledgeBaseId: true,
      knowledgeBase: { select: { userId: true } },
      type: true,
      originalFileName: true,
      mimeType: true,
      sizeBytes: true,
      checksumSha256: true,
      storageKey: true,
      parseMetadata: true,
      contentRevision: true,
    },
  })
  if (!document) {
    await prisma.documentProcessingJob.updateMany({
      where: { id: job.id, lockToken: job.lockToken },
      data: {
        status: "CANCELLED",
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
      },
    })
    return
  }

  // 根据文档类型选择 PDF、DOCX、Markdown 或纯文本解析器。
  const kind = documentKinds[document.type]
  if (
    !document.storageKey ||
    !document.originalFileName ||
    !document.mimeType
  ) {
    throw new KnowledgeParseError("UNSUPPORTED_FILE_TYPE", "文档类型不支持解析")
  }

  // 下载原文件，并用上传时保存的大小和哈希检查内容完整性。
  const input = await getOssObject(document.storageKey)
  const checksum = createHash("sha256").update(input).digest("hex")
  if (
    input.byteLength !== document.sizeBytes ||
    checksum !== document.checksumSha256
  ) {
    throw new KnowledgeParseError(
      "FILE_SIGNATURE_MISMATCH",
      "原文件完整性校验失败，请重新上传"
    )
  }

  const parser = getKnowledgeParser(kind)
  const previousAssetNames = getKnowledgeAssetNames(document.parseMetadata)
  const uploadedAssetNames: string[] = []
  let assetIndex = 0
  let parseFailed = false
  const registerFailedAssetCleanup = async (assetNames: string[]) => {
    if (!assetNames.length) return
    // 文档或知识库可能已被物理删除，清理任务只依赖 payload，不写关联外键。
    await prisma.documentProcessingJob.createMany({
      skipDuplicates: true,
      data: assetNames.map((assetName) => ({
        type: "CLEANUP",
        dedupeKey: `cleanup:${document.id}:${assetName}`,
        payload: {
          storageKey: getKnowledgeAssetStorageKey(document.id, assetName),
          documentId: document.id,
          reason: "parse-failed",
        },
      })),
    })
  }

  try {
    // 解析器通过 uploadAsset 回调上传图片，并取得可写入 Markdown 的访问地址。
    const result = await withTimeout(
      parser.parse(input, {
        filename: document.originalFileName,
        mimeType: document.mimeType,
        uploadAsset: async ({ data, mediaType }) => {
          if (parseFailed) throw new Error("解析任务已结束")
          assetIndex += 1
          const extension =
            mediaType === "image/jpeg"
              ? "jpg"
              : mediaType === "image/webp"
                ? "webp"
                : "png"
          const assetName = `${job.id}-${String(assetIndex).padStart(4, "0")}.${extension}`
          await putOssObject(
            getKnowledgeAssetStorageKey(document.id, assetName),
            data,
            mediaType
          )
          // 超时后仍可能有正在上传的图片；上传完成后同样登记持久化清理。
          if (parseFailed) await registerFailedAssetCleanup([assetName])
          else uploadedAssetNames.push(assetName)
          return getKnowledgeAssetUrl(document.id, assetName)
        },
      }),
      MAX_PARSE_TIME_MS
    )

    await prisma.$transaction(async (db) => {
      // 与删除共用锁：删除必须读到已提交的新资源清单，不能漏掉刚生成的图片。
      await lockOwnedKnowledgeBase(
        db,
        document.knowledgeBase.userId,
        document.knowledgeBaseId
      )
      // 文档内容、资源清单和任务成功状态必须在同一事务中提交。
      const updatedDocument = await db.knowledgeDocument.updateMany({
        where: {
          id: document.id,
          deletedAt: null,
          contentRevision: document.contentRevision,
        },
        data: {
          status: "READY",
          markdownContent: result.markdown,
          contentRevision: { increment: 1 },
          parserVersion: parser.version,
          parseMetadata: toJson({
            ...result.metadata,
            assetNames: uploadedAssetNames,
            sections: result.sections,
            warnings: result.warnings,
          }),
          parseErrorCode: null,
          parseErrorMessage: null,
          parsedAt: new Date(),
          chunkStatus: "PENDING",
          chunkedContentRevision: null,
          chunkErrorMessage: null,
        },
      })
      if (updatedDocument.count !== 1)
        throw new Error("文档已被删除或正文版本已变化")

      const updatedJob = await db.documentProcessingJob.updateMany({
        where: { id: job.id, status: "RUNNING", lockToken: job.lockToken },
        data: {
          status: "SUCCEEDED",
          lockedAt: null,
          lockedUntil: null,
          lockToken: null,
          lastError: null,
        },
      })
      if (updatedJob.count !== 1) throw new Error("文档任务租约已失效")
      await registerRechunkJob(db, {
        id: document.id,
        knowledgeBaseId: document.knowledgeBaseId,
        contentRevision: document.contentRevision + 1,
      })
      // 与新正文一起登记旧图片清理；OSS 暂时不可用时仍由现有 Worker 重试。
      await registerCleanupJobs(
        db,
        [
          {
            ...document,
            storageKey: null,
            parseMetadata: {
              assetNames: previousAssetNames.filter(
                (name) => !uploadedAssetNames.includes(name)
              ),
            },
          },
        ],
        "reparse"
      )
    }, transactionOptions)
  } catch (error) {
    // 删除或租约失效导致提交失败时，新资源由清理任务回收，OSS 失败可以重试。
    parseFailed = true
    await registerFailedAssetCleanup(uploadedAssetNames)
    throw error
  }
}

const cancelRechunkJob = async (db: KnowledgeTransaction, job: ClaimedJob) => {
  await db.documentProcessingJob.updateMany({
    where: { id: job.id, status: "RUNNING", lockToken: job.lockToken },
    data: {
      status: "CANCELLED",
      lockedAt: null,
      lockedUntil: null,
      lockToken: null,
    },
  })
}

const processRechunkJob = async (job: ClaimedJob) => {
  if (!job.documentId || job.targetRevision === null) {
    throw new Error("分块任务缺少文档或正文版本")
  }
  const targetRevision = job.targetRevision
  const initial = await prisma.knowledgeDocument.findFirst({
    where: {
      id: job.documentId,
      deletedAt: null,
      knowledgeBase: { deletedAt: null },
    },
    select: {
      knowledgeBaseId: true,
      knowledgeBase: { select: { userId: true } },
    },
  })
  if (!initial) {
    await cancelRechunkJob(prisma, job)
    return
  }

  const where = {
    id: job.documentId,
    contentRevision: targetRevision,
    status: "READY" as const,
    deletedAt: null,
    knowledgeBase: { deletedAt: null },
  }
  const document = await prisma.$transaction(async (db) => {
    await lockOwnedKnowledgeBase(
      db,
      initial.knowledgeBase.userId,
      initial.knowledgeBaseId
    )
    const current = await db.knowledgeDocument.findFirst({
      where,
      select: {
        id: true,
        title: true,
        markdownContent: true,
        parseMetadata: true,
      },
    })
    if (!current) {
      await cancelRechunkJob(db, job)
      return null
    }
    // 更新同时锁住任务行，防止租约被接管后仍把文档标成 RUNNING。
    const active = await db.documentProcessingJob.updateMany({
      where: {
        id: job.id,
        status: "RUNNING",
        lockToken: job.lockToken,
        lockedUntil: { gt: new Date() },
      },
      data: { lastError: null },
    })
    if (active.count !== 1) return null
    await db.knowledgeDocument.updateMany({
      where,
      data: { chunkStatus: "RUNNING", chunkErrorMessage: null },
    })
    return current
  }, transactionOptions)
  if (!document) return
  if (document.markdownContent === null)
    throw new Error("文档缺少 Markdown 正文")

  const metadata = document.parseMetadata
  // sections 由本项目解析器生成，JSON 读取后恢复已有类型契约。
  const sections =
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Array.isArray(metadata.sections)
      ? (metadata.sections as unknown as ParsedSection[])
      : undefined
  const chunks = await chunkMarkdown(document.markdownContent, sections)
  // 总请求时间受本次租约约束；预留事务落库时间，超时真正中止网络请求。
  const abortSignal = AbortSignal.timeout(
    Math.max(
      1,
      job.lockedUntil.getTime() - Date.now() - transactionOptions.timeout - 5_000
    )
  )
  const { embeddings, embeddingModel } = await embedDocumentChunks({
    documentTitle: document.title,
    chunks,
    abortSignal,
  })

  await indexKnowledgeChunks({
    userId: initial.knowledgeBase.userId,
    knowledgeBaseId: initial.knowledgeBaseId,
    documentId: document.id,
    documentTitle: document.title,
    contentRevision: targetRevision,
    chunks,
    abortSignal,
  })

  await prisma.$transaction(async (db) => {
    await lockOwnedKnowledgeBase(
      db,
      initial.knowledgeBase.userId,
      initial.knowledgeBaseId
    )
    // 先核实并锁住任务行；最后再确认租约未过期并提交成功状态。
    const active = await db.documentProcessingJob.updateMany({
      where: {
        id: job.id,
        status: "RUNNING",
        lockToken: job.lockToken,
        lockedUntil: { gt: new Date() },
      },
      data: { lastError: null },
    })
    if (active.count !== 1) return
    const updated = await db.knowledgeDocument.updateMany({
      where,
      data: {
        chunkStatus: "READY",
        chunkedContentRevision: targetRevision,
        chunkErrorMessage: null,
      },
    })
    if (updated.count !== 1) {
      await cancelRechunkJob(db, job)
      return
    }
    await replaceDocumentChunks(db, {
      documentId: document.id,
      contentRevision: targetRevision,
      chunks,
      embeddings,
      embeddingModel,
    })
    const completed = await db.documentProcessingJob.updateMany({
      where: {
        id: job.id,
        status: "RUNNING",
        lockToken: job.lockToken,
        lockedUntil: { gt: new Date() },
      },
      data: {
        status: "SUCCEEDED",
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: null,
      },
    })
    if (completed.count !== 1) throw new Error("文档索引任务租约已失效")
  }, transactionOptions)
}

const classifyFailure = (error: unknown) => {
  // 解析器会说明错误是否适合重试；未知错误默认按临时故障处理。
  if (error instanceof KnowledgeParseError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }
  }
  return {
    code: "PARSE_FAILED",
    message: "文档解析失败，请稍后重试",
    retryable: true,
  }
}

const failOrRetryJob = async (job: ClaimedJob, error: unknown) => {
  const failure =
    job.type === "RECHUNK"
      ? {
          code: "RECHUNK_FAILED",
          message:
            error instanceof Error ? error.message : "文档索引失败，请稍后重试",
          retryable: true,
        }
      : classifyFailure(error)
  const shouldRetry = failure.retryable && job.attempts < job.maxAttempts
  console.error(`Document job ${job.id} failed`, error)

  const document =
    job.type === "RECHUNK" && job.documentId
      ? await prisma.knowledgeDocument.findFirst({
          where: {
            id: job.documentId,
            deletedAt: null,
            knowledgeBase: { deletedAt: null },
          },
          select: {
            knowledgeBaseId: true,
            knowledgeBase: { select: { userId: true } },
          },
        })
      : null
  await prisma.$transaction(async (db) => {
    // 与保存/删除保持同一锁顺序，避免任务行和文档行互相等待。
    if (document) {
      await lockOwnedKnowledgeBase(
        db,
        document.knowledgeBase.userId,
        document.knowledgeBaseId
      )
    }
    const updatedJob = await db.documentProcessingJob.updateMany({
      where: {
        id: job.id,
        status: "RUNNING",
        lockToken: job.lockToken,
        ...(job.type === "RECHUNK" ? { lockedUntil: { gt: new Date() } } : {}),
      },
      // 可重试任务使用简单的指数退避，避免连续请求暂时不可用的服务。
      data: {
        status: shouldRetry ? "PENDING" : "FAILED",
        ...(shouldRetry
          ? {
              availableAt: new Date(
                Date.now() + Math.min(60_000, 2 ** job.attempts * 1_000)
              ),
            }
          : {}),
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: `${failure.code}: ${failure.message}`.slice(0, 2_000),
      },
    })
    if (updatedJob.count !== 1) return

    if (
      job.documentId &&
      job.type === "RECHUNK" &&
      job.targetRevision !== null
    ) {
      await db.knowledgeDocument.updateMany({
        where: {
          id: job.documentId,
          contentRevision: job.targetRevision,
          status: "READY",
          deletedAt: null,
          knowledgeBase: { deletedAt: null },
        },
        data: {
          chunkStatus: shouldRetry ? "PENDING" : "FAILED",
          chunkErrorMessage: failure.message.slice(0, 2_000),
        },
      })
    } else if (
      job.documentId &&
      (job.type === "PARSE" || job.type === "REPARSE")
    ) {
      // 等待重试时文档回到 QUEUED；重试耗尽后才进入 FAILED。
      await db.knowledgeDocument.updateMany({
        where: { id: job.documentId, deletedAt: null },
        data: {
          status: shouldRetry ? "QUEUED" : "FAILED",
          parseErrorCode: shouldRetry ? null : failure.code,
          parseErrorMessage: shouldRetry ? null : failure.message,
        },
      })
    }
  }, transactionOptions)
}

/** 至多领取并处理一个任务；返回 false 表示当前队列为空。 */
export const processNextDocumentJob = async () => {
  const job = await claimNextJob()
  if (!job) return false
  try {
    if (job.type === "CLEANUP") await completeCleanupJob(job)
    else if (job.type === "RECHUNK") await processRechunkJob(job)
    else await processParseJob(job)
  } catch (error) {
    await failOrRetryJob(job, error)
  }
  return true
}
