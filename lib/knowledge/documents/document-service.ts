import "server-only"

/**
 * 知识库文档服务。
 *
 * 负责文件上传处理、原件下载和解析正文及资源读取。
 * HTTP 接口只做参数校验，具体业务流程集中在这里，方便复用和测试。
 */

import { createHash, randomUUID } from "node:crypto"
import type { Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import {
  getKnowledgeAssetMediaType,
  getKnowledgeAssetStorageKey,
  isSafeKnowledgeAssetName,
} from "@/lib/knowledge/documents/assets"
import {
  KnowledgeError,
  knowledgeDocumentNotFound,
} from "@/lib/knowledge/errors"
import {
  requireFolderInKnowledgeBase,
  lockOwnedKnowledgeBase,
} from "@/lib/knowledge/ownership"
import { DOCUMENT_PROCESSING_TIMEOUT_MS } from "@/lib/knowledge/documents/timeouts"
import { cleanupKnowledgeResources } from "./cleanup"
import { processKnowledgeDocument } from "./process-document"
import { KnowledgeParseError } from "@/lib/knowledge/parsers/types"
import { inspectKnowledgeFile } from "@/lib/knowledge/parsers/registry"
import { titleFromFilename } from "@/lib/knowledge/parsers/normalize"
import type {
  PrepareKnowledgeDocumentUploadInput,
  ReparseKnowledgeDocumentInput,
  RenameKnowledgeDocumentInput,
} from "@/lib/knowledge/schemas"
import {
  copyOssObject,
  getOssObject,
  getOssUploadUrl,
  getOssPreviewUrl,
} from "@/lib/storage/oss"

// 文档详情接口统一使用的字段集合，避免把 storageKey 等内部字段返回给前端。
const documentDetailSelect = {
  id: true,
  knowledgeBaseId: true,
  folderId: true,
  title: true,
  type: true,
  status: true,
  originalFileName: true,
  mimeType: true,
  sizeBytes: true,
  checksumSha256: true,
  markdownContent: true,
  contentRevision: true,
  parserVersion: true,
  parseMetadata: true,
  parseErrorCode: true,
  parseErrorMessage: true,
  parsedAt: true,
  chunkStatus: true,
  chunkedContentRevision: true,
  chunkErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeDocumentSelect

// 去掉路径和不可见字符，防止客户端传入的文件名影响对象存储路径。
const sanitizeFilename = (filename: string) => {
  const leaf = filename.replace(/\\/g, "/").split("/").at(-1) ?? ""
  const sanitized = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255)
  return sanitized || "未命名文件"
}
export const prepareKnowledgeDocumentUpload = async (
  userId: string,
  knowledgeBaseId: string,
  input: PrepareKnowledgeDocumentUploadInput
) => {
  const id = randomUUID()
  const filename = sanitizeFilename(input.filename)
  const storageKey = `knowledge-uploads/${userId}/${knowledgeBaseId}/${id}`
  const sourceKey = `knowledge-documents/${userId}/${knowledgeBaseId}/${id}`
  const expires = 10 * 60
  const expiresAt = Date.now() + expires * 1000

  await prisma.$transaction(async (db) => {
    await lockOwnedKnowledgeBase(db, userId, knowledgeBaseId)
    if (input.folderId)
      await requireFolderInKnowledgeBase(db, knowledgeBaseId, input.folderId)
    // 先登记清理记录，浏览器关闭或直传失败也不会丢失原件的清理线索。
    await db.documentProcessingJob.createMany({
      data: [
        {
          id,
          knowledgeBaseId,
          type: "CLEANUP",
          dedupeKey: `cleanup:upload:${id}`,
          availableAt: new Date(expiresAt + DOCUMENT_PROCESSING_TIMEOUT_MS),
          // 临时对象始终延后清理，不参与已完成文档的即时清理。
          payload: { ...input, filename, storageKey, sourceKey, userId },
        },
        {
          knowledgeBaseId,
          type: "CLEANUP",
          dedupeKey: `cleanup:upload-source:${id}`,
          availableAt: new Date(expiresAt + DOCUMENT_PROCESSING_TIMEOUT_MS),
          payload: { storageKey: sourceKey, documentId: id },
        },
      ],
    })
  })

  return {
    uploadId: id,
    ...(await getOssUploadUrl(
      storageKey,
      input.mimeType,
      input.sizeBytes,
      expires
    )),
  }
}

export const createKnowledgeDocumentUpload = async ({
  userId,
  knowledgeBaseId,
  uploadId,
  signal,
}: {
  userId: string
  knowledgeBaseId: string
  uploadId: string
  signal?: AbortSignal
}) => {
  signal?.throwIfAborted()
  const pending = await prisma.documentProcessingJob.findFirst({
    where: {
      id: uploadId,
      knowledgeBaseId,
      type: "CLEANUP",
      status: "PENDING",
      dedupeKey: `cleanup:upload:${uploadId}`,
      availableAt: {
        gt: new Date(Date.now() + DOCUMENT_PROCESSING_TIMEOUT_MS),
      },
      payload: { path: ["userId"], equals: userId },
    },
  })
  if (!pending) throw knowledgeDocumentNotFound()
  // payload 由上面的准备接口持久化，不接受客户端指定对象键或修改上传元数据。
  const { filename, mimeType, folderId, sizeBytes, storageKey, sourceKey } =
    pending.payload as PrepareKnowledgeDocumentUploadInput & {
      storageKey: string
      sourceKey: string
    }
  const buffer = await getOssObject(storageKey)
  if (buffer.byteLength !== sizeBytes)
    throw new KnowledgeParseError(
      "FILE_SIGNATURE_MISMATCH",
      "上传文件大小不一致，请重新上传"
    )
  const id = uploadId
  const originalFileName = filename
  const inspected = inspectKnowledgeFile({
    buffer,
    filename: originalFileName,
    mimeType,
  })

  const checksumSha256 = createHash("sha256").update(buffer).digest("hex")
  // 正式原件不暴露上传签名，防止旧签名在文档删除后重新写入同一路径。
  await copyOssObject(storageKey, sourceKey, inspected.mimeType)
  signal?.throwIfAborted()
  await prisma.$transaction(async (db) => {
    // 与整库/目录删除串行，保证删除时能读到新文档的资源信息。
    await lockOwnedKnowledgeBase(db, userId, knowledgeBaseId)
    if (folderId)
      await requireFolderInKnowledgeBase(db, knowledgeBaseId, folderId)

    // 与文档创建原子提交，阻止重复确认；事务失败时仍保留原清理记录。
    const claimed = await db.documentProcessingJob.updateMany({
      where: {
        id: pending.id,
        status: "PENDING",
        dedupeKey: `cleanup:upload:${id}`,
      },
      data: { dedupeKey: `cleanup:uploaded:${id}` },
    })
    if (claimed.count !== 1) throw knowledgeDocumentNotFound()
    await db.documentProcessingJob.deleteMany({
      where: { dedupeKey: `cleanup:upload-source:${id}`, status: "PENDING" },
    })

    // 先保存原件记录；解析与索引在事务提交后直接执行。
    signal?.throwIfAborted()
    await db.knowledgeDocument.create({
      data: {
        id,
        knowledgeBaseId,
        folderId,
        title: titleFromFilename(originalFileName),
        type: inspected.documentType,
        status: "QUEUED",
        originalFileName,
        mimeType: inspected.mimeType,
        sizeBytes: buffer.byteLength,
        checksumSha256,
        storageKey: sourceKey,
      },
      select: { id: true },
    })

    signal?.throwIfAborted()
  })

  return processOwnedKnowledgeDocument(userId, id, 0, {
    source: buffer,
    signal,
  })
}

/** 上传与重解析共用结果及失败补偿，具体阶段状态由处理函数维护。 */
async function processOwnedKnowledgeDocument(
  userId: string,
  id: string,
  initialRevision: number,
  input: Pick<
    Parameters<typeof processKnowledgeDocument>[0],
    "source" | "signal" | "expectedContentRevision"
  >
) {
  try {
    await processKnowledgeDocument({
      userId,
      ...input,
      documentId: id,
    })
  } catch (error) {
    if (error instanceof KnowledgeError) {
      if (error.code === "CONTENT_REVISION_CONFLICT")
        await cleanupKnowledgeResources([id])
      throw error
    }
    const document = await getOwnedKnowledgeDocument(userId, id)
    const phase = document.contentRevision > initialRevision ? "index" : "parse"
    // 阶段之间中止也要落入失败状态，避免留下无人接手的处理中记录。
    const where = {
      id,
      deletedAt: null,
      knowledgeBase: { userId, deletedAt: null },
    }
    if (
      input.expectedContentRevision === undefined &&
      document.status === "QUEUED" &&
      document.contentRevision === initialRevision
    ) {
      await prisma.knowledgeDocument.updateMany({
        where: { ...where, status: "QUEUED", contentRevision: initialRevision },
        data: {
          status: "FAILED",
          parseErrorCode: "PARSE_FAILED",
          parseErrorMessage:
            error instanceof Error ? error.message : "文档处理失败",
        },
      })
    } else if (
      document.status === "READY" &&
      document.contentRevision === initialRevision + 1 &&
      document.chunkStatus === "PENDING"
    ) {
      await prisma.knowledgeDocument.updateMany({
        where: {
          ...where,
          status: "READY",
          chunkStatus: "PENDING",
          contentRevision: initialRevision + 1,
        },
        data: {
          chunkStatus: "FAILED",
          chunkErrorMessage:
            error instanceof Error ? error.message : "文档索引失败",
        },
      })
    }
    const cleanup = await cleanupKnowledgeResources([id])
    input.signal?.throwIfAborted()
    const failure = new KnowledgeError(
      "KNOWLEDGE_DOCUMENT_PROCESSING_FAILED",
      error instanceof KnowledgeParseError
        ? error.message
        : phase === "parse"
          ? "文件已保存，但解析失败。请在文档中查看错误详情。"
          : "文件和正文已保存，但索引失败。请在文档中查看错误详情。",
      error instanceof KnowledgeParseError
        ? error.status
        : error instanceof Error && error.name === "TimeoutError"
          ? 504
          : 502,
      {
        documentId: id,
        phase,
        cleanupPending: cleanup.failed + cleanup.pending,
      }
    )
    failure.cause = error
    throw failure
  }
  const cleanup = await cleanupKnowledgeResources([id])
  if (cleanup.failed || cleanup.pending)
    throw new KnowledgeError(
      "KNOWLEDGE_CLEANUP_FAILED",
      "文档解析和索引已完成，但旧资源尚未清理完成，请联系管理员处理",
      502,
      {
        documentId: id,
        phase: "cleanup",
        cleanupPending: cleanup.failed + cleanup.pending,
      }
    )
  return getOwnedKnowledgeDocument(userId, id)
}

export const getOwnedKnowledgeDocument = async (userId: string, id: string) => {
  // 查询条件始终包含 userId，防止通过猜测文档 ID 读取他人数据。
  const document = await prisma.knowledgeDocument.findFirst({
    where: {
      id,
      deletedAt: null,
      knowledgeBase: { userId, deletedAt: null },
    },
    select: documentDetailSelect,
  })
  if (!document) throw knowledgeDocumentNotFound()
  return document
}

/** 改名与目录删除共用锁；只更新标题和元数据版本，不触碰正文、解析任务或原件。 */
export const renameKnowledgeDocument = async (
  userId: string,
  id: string,
  input: RenameKnowledgeDocumentInput
) =>
  prisma.$transaction(async (db) => {
    const where = {
      id,
      deletedAt: null,
      knowledgeBase: { userId, deletedAt: null },
    }
    const document = await db.knowledgeDocument.findFirst({
      where,
      select: { knowledgeBaseId: true },
    })
    if (!document) throw knowledgeDocumentNotFound()
    await lockOwnedKnowledgeBase(db, userId, document.knowledgeBaseId)
    const updated = await db.knowledgeDocument.updateMany({
      where,
      data: { title: input.title },
    })
    if (updated.count !== 1) throw knowledgeDocumentNotFound()
    return db.knowledgeDocument.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        knowledgeBaseId: true,
        title: true,
        updatedAt: true,
      },
    })
  })

/** 原件只能通过服务端所有权查询取得，客户端不能指定 OSS 对象键。 */
export const readOwnedKnowledgeDocumentOriginal = async (
  userId: string,
  id: string
) => {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id, deletedAt: null, knowledgeBase: { userId, deletedAt: null } },
    select: { storageKey: true, originalFileName: true },
  })
  if (!document) throw knowledgeDocumentNotFound()
  if (!document.storageKey || !document.originalFileName)
    throw new KnowledgeError(
      "KNOWLEDGE_DOCUMENT_NO_ORIGINAL",
      "文档没有可下载的原件",
      409
    )
  return {
    content: await getOssObject(document.storageKey),
    filename: sanitizeFilename(document.originalFileName),
  }
}

/** 预览只依赖原件元数据，不读取解析正文或检查 MinerU 状态。 */
export const getOwnedKnowledgeFilePreview = async (
  userId: string,
  id: string
) => {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id, deletedAt: null, knowledgeBase: { userId, deletedAt: null } },
    select: { originalFileName: true, mimeType: true, storageKey: true },
  })
  if (!document) throw knowledgeDocumentNotFound()
  if (!document.storageKey || !document.originalFileName)
    throw new KnowledgeError(
      "KNOWLEDGE_DOCUMENT_NO_ORIGINAL",
      "文档没有可预览的原件",
      409
    )
  const expires = 15 * 60
  return {
    fileName: sanitizeFilename(document.originalFileName),
    mimeType: document.mimeType,
    url: await getOssPreviewUrl(document.storageKey, expires),
    expiresAt: Date.now() + expires * 1000,
  }
}

/** 按用户确认的版本重新解析并建立索引，全部完成后才返回。 */
export const reparseKnowledgeDocument = async (
  userId: string,
  id: string,
  input: ReparseKnowledgeDocumentInput,
  signal?: AbortSignal
) =>
  processOwnedKnowledgeDocument(userId, id, input.expectedContentRevision, {
    expectedContentRevision: input.expectedContentRevision,
    signal,
  })

export const readOwnedKnowledgeDocumentAsset = async (
  userId: string,
  documentId: string,
  assetName: string
) => {
  // assetName 只能是解析任务生成的固定格式，不能作为任意 OSS 路径使用。
  if (!isSafeKnowledgeAssetName(assetName)) throw knowledgeDocumentNotFound()
  // 先通过知识库关系验证文档所有权，再读取对应的解析资源。
  const document = await prisma.knowledgeDocument.findFirst({
    where: {
      id: documentId,
      deletedAt: null,
      knowledgeBase: { userId, deletedAt: null },
    },
    select: { id: true },
  })
  if (!document) throw knowledgeDocumentNotFound()

  const content = await getOssObject(
    getKnowledgeAssetStorageKey(document.id, assetName)
  )
  return {
    content,
    mediaType: getKnowledgeAssetMediaType(assetName),
  }
}
