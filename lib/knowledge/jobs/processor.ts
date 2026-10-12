import "server-only"

/**
 * 知识库后台任务处理器。
 *
 * Worker 从数据库领取任务，下载原文件，调用解析器生成 Markdown，
 * 再以事务方式更新文档和任务状态。任务租约用来避免多个 Worker 重复处理。
 */

import { createHash, randomUUID } from "node:crypto"
import type {
  DocumentProcessingJobType,
  KnowledgeDocumentType,
  Prisma,
} from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import { registerCleanupJobs } from "@/lib/knowledge/service"
import { lockOwnedKnowledgeBase } from "@/lib/knowledge/ownership"
import {
  getKnowledgeAssetNames,
  getKnowledgeAssetStorageKey,
  getKnowledgeAssetUrl,
} from "@/lib/knowledge/assets"
import { getKnowledgeParser } from "@/lib/knowledge/parsers/registry"
import {
  KnowledgeParseError,
  type KnowledgeSourceKind,
} from "@/lib/knowledge/parsers/types"
import { deleteOssObject, getOssObject, putOssObject } from "@/lib/storage/oss"

// 租约比解析超时多两分钟，为结果落库和资源清理预留时间。
const MAX_PARSE_TIME_MS = Number(process.env.MINERU_TIMEOUT_MS ?? 8 * 60 * 1000)
const JOB_LEASE_MS = MAX_PARSE_TIME_MS + 2 * 60 * 1000

// 处理阶段只需要这些已领取任务字段。
type ClaimedJob = {
  id: string
  documentId: string | null
  type: DocumentProcessingJobType
  payload: Prisma.JsonValue
  attempts: number
  maxAttempts: number
  lockToken: string
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
      type: { in: ["PARSE", "REPARSE", "CLEANUP"] },
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
    },
  })
  if (!candidate) return null

  // lockToken 是本次领取的凭证，之后的状态更新必须同时匹配它。
  const lockToken = randomUUID()
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
      lockedUntil: new Date(now.getTime() + JOB_LEASE_MS),
      lockToken,
      lastError: null,
    },
  })
  if (claimed.count !== 1) return null

  // 领取成功后同步文档状态，前端可以及时显示“解析中”。
  // CLEANUP 不属于解析，不能把仍有效的文档错误地改成 PARSING。
  if (candidate.documentId && candidate.type !== "CLEANUP") {
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
  }
}

const completeCleanupJob = async (job: ClaimedJob) => {
  // JSON 来自持久化任务，必须确认对象键有效后才能执行删除。
  const payload = job.payload
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.storageKey !== "string"
  ) {
    throw new Error("文档任务缺少 storageKey")
  }
  await deleteOssObject(payload.storageKey)
  await prisma.documentProcessingJob.updateMany({
    where: { id: job.id, status: "RUNNING", lockToken: job.lockToken },
    data: {
      status: "SUCCEEDED",
      lockedAt: null,
      lockedUntil: null,
      lockToken: null,
      lastError: null,
    },
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
  // 资源清理失败不影响已经完成的文档解析，只记录错误供排查。
  const deleteAssetsBestEffort = async (assetNames: string[]) => {
    const results = await Promise.allSettled(
      assetNames.map((assetName) =>
        deleteOssObject(getKnowledgeAssetStorageKey(document.id, assetName))
      )
    )
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `Failed to delete knowledge asset ${assetNames[index]}`,
          result.reason
        )
      }
    })
  }

  try {
    // 解析器通过 uploadAsset 回调上传图片，并取得可写入 Markdown 的访问地址。
    const result = await withTimeout(
      parser.parse(input, {
        filename: document.originalFileName,
        mimeType: document.mimeType,
        uploadAsset: async ({ data, mediaType }) => {
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
          uploadedAssetNames.push(assetName)
          return getKnowledgeAssetUrl(document.id, assetName)
        },
      }),
      MAX_PARSE_TIME_MS
    )

    await prisma.$transaction(
      async (db) => {
        // 与删除共用锁：删除必须读到已提交的新资源清单，不能漏掉刚生成的图片。
        await lockOwnedKnowledgeBase(
          db,
          document.knowledgeBase.userId,
          document.knowledgeBaseId
        )
        // 文档内容、资源清单和任务成功状态必须在同一事务中提交。
        const updatedDocument = await db.knowledgeDocument.updateMany({
          where: { id: document.id, deletedAt: null },
          data: {
            status: "READY",
            markdownContent: result.markdown,
            plainText: result.plainText,
            revision: { increment: 1 },
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
          },
        })
        if (updatedDocument.count !== 1) throw new Error("文档已被删除")

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
      },
      { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 }
    )
  } catch (error) {
    // 事务失败时，新资源尚未被文档正式引用，需要主动回收。
    await deleteAssetsBestEffort(uploadedAssetNames)
    throw error
  }
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
  const failure = classifyFailure(error)
  const shouldRetry = failure.retryable && job.attempts < job.maxAttempts
  console.error(`Document job ${job.id} failed`, error)

  await prisma.$transaction(async (db) => {
    const updatedJob = await db.documentProcessingJob.updateMany({
      where: { id: job.id, status: "RUNNING", lockToken: job.lockToken },
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

    if (job.documentId && job.type !== "CLEANUP") {
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
  })
}

/** 至多领取并处理一个任务；返回 false 表示当前队列为空。 */
export const processNextDocumentJob = async () => {
  const job = await claimNextJob()
  if (!job) return false
  try {
    if (job.type === "CLEANUP") await completeCleanupJob(job)
    else await processParseJob(job)
  } catch (error) {
    await failOrRetryJob(job, error)
  }
  return true
}
