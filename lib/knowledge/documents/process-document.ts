import "server-only"

import { createHash, randomUUID } from "node:crypto"
import type { KnowledgeDocumentType, Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import { chunkMarkdown } from "@/lib/knowledge/indexing/chunk"
import { embedDocumentChunks } from "@/lib/knowledge/indexing/embedding"
import { replaceDocumentChunks } from "@/lib/knowledge/indexing/indexing"
import { indexKnowledgeChunks } from "@/lib/es/knowledge-index"
import { registerCleanupJobs } from "@/lib/knowledge/management/service"
import {
  knowledgeDocumentNotFound,
  KnowledgeError,
} from "@/lib/knowledge/errors"
import { lockOwnedKnowledgeBase } from "@/lib/knowledge/ownership"
import {
  MAX_DOCUMENT_PARSE_TIME_MS,
  DOCUMENT_PROCESSING_TIMEOUT_MS,
} from "@/lib/knowledge/documents/timeouts"
import { getKnowledgeParser } from "@/lib/knowledge/parsers/registry"
import {
  KnowledgeParseError,
  type KnowledgeSourceKind,
  type ParsedSection,
} from "@/lib/knowledge/parsers/types"
import { getOssObject, putOssObject } from "@/lib/storage/oss"
import {
  getKnowledgeAssetNames,
  getKnowledgeAssetStorageKey,
  getKnowledgeAssetUrl,
} from "./assets"

type ProcessingInput = {
  userId: string
  documentId: string
  signal?: AbortSignal
  timeoutMs?: number
}

const transactionOptions = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5_000,
  timeout: 30_000,
}

const documentKinds: Record<KnowledgeDocumentType, KnowledgeSourceKind> = {
  PDF: "pdf",
  DOCX: "docx",
  MARKDOWN: "markdown",
  TEXT: "txt",
}

const revisionConflict = () =>
  new KnowledgeError(
    "CONTENT_REVISION_CONFLICT",
    "文档已被删除或正文版本已变化",
    409
  )

/** 仅竞争不提交数据的外部等待；数据库事务须结束后再判断是否补偿清理。 */
async function waitForAbort<T>(signal: AbortSignal, execute: () => Promise<T>) {
  signal.throwIfAborted()
  let onAbort = () => { }
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    return await Promise.race([execute(), aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

async function withDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  input: Pick<ProcessingInput, "signal" | "timeoutMs">,
  defaultTimeoutMs: number,
  timeoutError: Error
) {
  input.signal?.throwIfAborted()
  if (input.timeoutMs !== undefined && input.timeoutMs <= 0) throw timeoutError
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    input.timeoutMs ?? defaultTimeoutMs
  )
  const signal = AbortSignal.any([
    controller.signal,
    ...(input.signal ? [input.signal] : []),
  ])
  try {
    const result = await execute(signal)
    signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** 解析并提交正文；调用方可直接 await，不需要领取或轮询任务。 */
export async function parseKnowledgeDocument(
  input: ProcessingInput & { source?: Buffer; expectedContentRevision?: number }
) {
  let failureWhere: Prisma.KnowledgeDocumentWhereInput | undefined
  let started = false
  let parseFailed = false
  let committed = false
  const uploadedAssetNames: string[] = []
  // 中止信号无法撤回已发出的 OSS 写入，失败状态必须等这些写入结束后再发布。
  const pendingAssetUploads = new Set<Promise<string>>()
  const uncertainAssetNames = new Set<string>()
  const operationId = randomUUID()
  let assetIndex = 0
  const registerFailedAssetCleanup = async (assetNames: string[]) => {
    if (!assetNames.length) return
    // 关联文档可能已被删除，资源回收只依赖独立保存的对象键。
    await prisma.documentProcessingJob.createMany({
      skipDuplicates: true,
      data: assetNames.map((assetName) => ({
        type: "CLEANUP",
        dedupeKey: `cleanup:${input.documentId}:${assetName}`,
        availableAt: new Date(
          Date.now() +
          (uncertainAssetNames.has(assetName)
            ? DOCUMENT_PROCESSING_TIMEOUT_MS
            : 0)
        ),
        payload: {
          storageKey: getKnowledgeAssetStorageKey(input.documentId, assetName),
          documentId: input.documentId,
          reason: "parse-failed",
        },
      })),
    })
  }
  try {
    return await withDeadline(
      async (signal) => {
        const document = await waitForAbort(signal, () =>
          prisma.knowledgeDocument.findFirst({
            where: {
              id: input.documentId,
              deletedAt: null,
              knowledgeBase: { userId: input.userId, deletedAt: null },
            },
            select: {
              id: true,
              knowledgeBaseId: true,
              type: true,
              originalFileName: true,
              mimeType: true,
              sizeBytes: true,
              checksumSha256: true,
              storageKey: true,
              parseMetadata: true,
              contentRevision: true,
              status: true,
              chunkStatus: true,
              updatedAt: true,
            },
          })
        )
        signal.throwIfAborted()
        if (!document) throw knowledgeDocumentNotFound()
        if (input.expectedContentRevision !== undefined) {
          if (
            !document.storageKey ||
            !document.originalFileName ||
            !document.mimeType
          )
            throw new KnowledgeError(
              "KNOWLEDGE_DOCUMENT_NO_ORIGINAL",
              "文档没有可重新解析的原件",
              409
            )
          if (
            document.status === "QUEUED" ||
            document.status === "PARSING" ||
            document.chunkStatus === "RUNNING"
          )
            throw new KnowledgeError(
              "KNOWLEDGE_DOCUMENT_PROCESSING",
              "文档正在处理中，请等待当前处理完成",
              409
            )
          if (document.contentRevision !== input.expectedContentRevision)
            throw revisionConflict()
        }
        const where = {
          id: document.id,
          deletedAt: null,
          contentRevision: document.contentRevision,
          knowledgeBase: { userId: input.userId, deletedAt: null },
        }
        failureWhere = where
        await prisma.$transaction(async (db) => {
          await lockOwnedKnowledgeBase(
            db,
            input.userId,
            document.knowledgeBaseId
          )
          signal.throwIfAborted()
          const updated = await db.knowledgeDocument.updateMany({
            where: {
              ...where,
              status:
                input.expectedContentRevision === undefined
                  ? { not: "PARSING" as const }
                  : { in: ["READY" as const, "FAILED" as const] },
              chunkStatus: { not: "RUNNING" as const },
            },
            data: {
              status: "PARSING",
              parseErrorCode: null,
              parseErrorMessage: null,
            },
          })
          if (updated.count !== 1) throw revisionConflict()
          signal.throwIfAborted()
        }, transactionOptions)
        started = true
        if (
          !document.storageKey ||
          !document.originalFileName ||
          !document.mimeType
        )
          throw new KnowledgeParseError(
            "UNSUPPORTED_FILE_TYPE",
            "文档类型不支持解析"
          )
        const storageKey = document.storageKey
        const source =
          input.source ??
          (await waitForAbort(signal, () => getOssObject(storageKey)))
        signal.throwIfAborted()
        if (
          source.byteLength !== document.sizeBytes ||
          createHash("sha256").update(source).digest("hex") !==
          document.checksumSha256
        )
          throw new KnowledgeParseError(
            "FILE_SIGNATURE_MISMATCH",
            "原文件完整性校验失败，请重新上传"
          )
        const filename = document.originalFileName
        const mimeType = document.mimeType
        const parser = getKnowledgeParser(documentKinds[document.type])
        const parsed = await waitForAbort(signal, () =>
          parser.parse(source, {
            filename,
            mimeType,
            signal,
            uploadAsset: async ({ data, mediaType }) => {
              const upload = (async () => {
                signal.throwIfAborted()
                if (parseFailed) throw new Error("文档解析已结束")
                const extension =
                  mediaType === "image/jpeg"
                    ? "jpg"
                    : mediaType === "image/webp"
                      ? "webp"
                      : "png"
                const assetName = `${operationId}-${String(++assetIndex).padStart(4, "0")}.${extension}`
                uploadedAssetNames.push(assetName)
                uncertainAssetNames.add(assetName)
                await putOssObject(
                  getKnowledgeAssetStorageKey(document.id, assetName),
                  data,
                  mediaType
                )
                uncertainAssetNames.delete(assetName)
                if (signal.aborted || parseFailed) {
                  signal.throwIfAborted()
                  throw new Error("文档解析已结束")
                }
                return getKnowledgeAssetUrl(document.id, assetName)
              })()
              pendingAssetUploads.add(upload)
              try {
                return await upload
              } finally {
                pendingAssetUploads.delete(upload)
              }
            },
          })
        )
        signal.throwIfAborted()
        const version = {
          id: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          contentRevision: document.contentRevision + 1,
        }
        await prisma.$transaction(async (db) => {
          await lockOwnedKnowledgeBase(
            db,
            input.userId,
            document.knowledgeBaseId
          )
          signal.throwIfAborted()
          const updated = await db.knowledgeDocument.updateMany({
            where,
            data: {
              status: "READY",
              markdownContent: parsed.markdown,
              contentRevision: { increment: 1 },
              parserVersion: parser.version,
              parseMetadata: JSON.parse(
                JSON.stringify({
                  ...parsed.metadata,
                  assetNames: uploadedAssetNames,
                  sections: parsed.sections,
                  warnings: parsed.warnings,
                })
              ) as Prisma.InputJsonValue,
              parseErrorCode: null,
              parseErrorMessage: null,
              parsedAt: new Date(),
              chunkStatus: "PENDING",
              chunkedContentRevision: null,
              chunkErrorMessage: null,
            },
          })
          if (updated.count !== 1) throw revisionConflict()
          await registerCleanupJobs(
            db,
            [
              {
                ...document,
                storageKey: null,
                parseMetadata: {
                  assetNames: getKnowledgeAssetNames(
                    document.parseMetadata
                  ).filter((name) => !uploadedAssetNames.includes(name)),
                },
              },
            ],
            "reparse"
          )
          signal.throwIfAborted()
        }, transactionOptions)
        committed = true
        return version
      },
      input,
      MAX_DOCUMENT_PARSE_TIME_MS,
      new KnowledgeParseError(
        "PARSE_TIMEOUT",
        "文档解析超时，请拆分文件后重试",
        413,
        true
      )
    )
  } catch (error) {
    parseFailed = true
    if (committed) throw error
    await Promise.allSettled(pendingAssetUploads)
    await registerFailedAssetCleanup(uploadedAssetNames)
    // 只记录实际失败阶段，重试由用户明确发起。
    if (started && failureWhere) {
      await prisma.knowledgeDocument.updateMany({
        where: { ...failureWhere, status: "PARSING" },
        data: {
          status: "FAILED",
          parseErrorCode:
            error instanceof KnowledgeParseError ? error.code : "PARSE_FAILED",
          parseErrorMessage:
            error instanceof Error && error.message
              ? error.message
              : input.signal?.aborted
                ? "解析请求已中断，请重新解析文档"
                : "文档解析失败，未返回具体错误原因",
        },
      })
    }
    throw error
  }
}

/** 为已保存的正文版本建立索引，ES 成功后才提交 PostgreSQL 就绪状态。 */
export async function indexKnowledgeDocument(
  input: ProcessingInput & { contentRevision: number }
) {
  let started = false
  let stage = "准备索引"
  let failureWhere: Prisma.KnowledgeDocumentWhereInput | undefined
  try {
    return await withDeadline(
      async (signal) => {
        const document = await waitForAbort(signal, () =>
          prisma.knowledgeDocument.findFirst({
            where: {
              id: input.documentId,
              deletedAt: null,
              knowledgeBase: { userId: input.userId, deletedAt: null },
            },
            select: {
              id: true,
              knowledgeBaseId: true,
              title: true,
              markdownContent: true,
              parseMetadata: true,
              contentRevision: true,
              status: true,
            },
          })
        )
        signal.throwIfAborted()
        if (!document) throw knowledgeDocumentNotFound()
        if (
          document.status !== "READY" ||
          document.contentRevision !== input.contentRevision
        )
          throw revisionConflict()
        const where = {
          id: document.id,
          deletedAt: null,
          status: "READY" as const,
          contentRevision: input.contentRevision,
          knowledgeBase: { userId: input.userId, deletedAt: null },
        }
        failureWhere = where
        await prisma.$transaction(async (db) => {
          await lockOwnedKnowledgeBase(
            db,
            input.userId,
            document.knowledgeBaseId
          )
          signal.throwIfAborted()
          const updated = await db.knowledgeDocument.updateMany({
            where: {
              ...where,
              chunkStatus: { not: "RUNNING" as const },
            },
            data: { chunkStatus: "RUNNING", chunkErrorMessage: null },
          })
          // 记录了 chunkStatus 的变更，避免重复索引。
          if (updated.count !== 1) throw revisionConflict()
          signal.throwIfAborted()
        }, transactionOptions)
        started = true
        if (document.markdownContent === null)
          throw new Error("文档缺少 Markdown 正文")
        const metadata = document.parseMetadata
        const sections =
          metadata &&
            typeof metadata === "object" &&
            !Array.isArray(metadata) &&
            Array.isArray(metadata.sections)
            ? (metadata.sections as unknown as ParsedSection[])
            : undefined
        stage = "分块"
        const chunks = await chunkMarkdown(document.markdownContent, sections)
        signal.throwIfAborted()
        stage = "向量化"
        const { embeddings, embeddingModel } = await waitForAbort(signal, () =>
          embedDocumentChunks({
            documentTitle: document.title,
            chunks,
            abortSignal: signal,
          })
        )
        signal.throwIfAborted()
        // 不能让中止竞争提前结束写入等待，否则删除可能先清理、后被晚到写入覆盖。
        stage = "Elasticsearch 写入"
        await indexKnowledgeChunks({
          userId: input.userId,
          knowledgeBaseId: document.knowledgeBaseId,
          documentId: document.id,
          documentTitle: document.title,
          contentRevision: input.contentRevision,
          chunks,
          abortSignal: signal,
        })
        signal.throwIfAborted()
        stage = "数据库提交"
        await prisma.$transaction(async (db) => {
          await lockOwnedKnowledgeBase(
            db,
            input.userId,
            document.knowledgeBaseId
          )
          signal.throwIfAborted()
          const updated = await db.knowledgeDocument.updateMany({
            where,
            data: {
              chunkStatus: "READY",
              chunkedContentRevision: input.contentRevision,
              chunkErrorMessage: null,
            },
          })
          if (updated.count !== 1) throw revisionConflict()
          await replaceDocumentChunks(db, {
            documentId: document.id,
            contentRevision: input.contentRevision,
            chunks,
            embeddings,
            embeddingModel,
          })
          signal.throwIfAborted()
        }, transactionOptions)
        return {
          id: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          contentRevision: document.contentRevision,
        }
      },
      input,
      DOCUMENT_PROCESSING_TIMEOUT_MS,
      new DOMException("文档索引超时", "TimeoutError")
    )
  } catch (error) {
    if (!(error instanceof KnowledgeError)) {
      // 仅记录定位所需字段，避免把 SDK 异常中的凭证、请求正文写进日志。
      console.error("Knowledge document indexing failed", {
        documentId: input.documentId,
        stage,
        errorName: error instanceof Error ? error.name : typeof error,
        causeName:
          error instanceof Error && error.cause instanceof Error
            ? error.cause.name
            : undefined,
        statusCode:
          error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
            ? error.statusCode
            : undefined,
      })
    }
    if (started && failureWhere) {
      await prisma.knowledgeDocument.updateMany({
        where: { ...failureWhere, chunkStatus: "RUNNING" },
        data: {
          chunkStatus: "FAILED",
          chunkErrorMessage:
            error instanceof Error && error.message
              ? error.message
              : input.signal?.aborted
                ? "索引请求已中断，请重新建立索引"
                : `文档索引失败：${stage}（${error instanceof Error ? error.name : "未知错误"}），未返回具体错误原因`,
        },
      })
    }
    throw error
  }
}

/** 共享总截止时间，依次完成解析和索引；错误按实际阶段向上传递。 */
export async function processKnowledgeDocument(
  input: ProcessingInput & {
    source?: Buffer
    expectedContentRevision?: number
  }
) {
  input.signal?.throwIfAborted()
  const timeoutMs = input.timeoutMs ?? DOCUMENT_PROCESSING_TIMEOUT_MS
  const timeoutError = new DOMException("文档处理超时", "TimeoutError")
  if (timeoutMs <= 0) throw timeoutError
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  const signal = AbortSignal.any([
    controller.signal,
    ...(input.signal ? [input.signal] : []),
  ])
  try {
    const parsed = await parseKnowledgeDocument({
      ...input,
      timeoutMs: MAX_DOCUMENT_PARSE_TIME_MS,
      signal,
    })
    signal.throwIfAborted()
    return await indexKnowledgeDocument({
      userId: input.userId,
      documentId: parsed.id,
      contentRevision: parsed.contentRevision,
      signal,
    })
  } finally {
    clearTimeout(timer)
  }
}
