import "server-only"

/**
 * 知识库文档服务。
 *
 * 负责文件上传、解析任务入队、正文保存、原件下载和解析资源读取。
 * HTTP 接口只做参数校验，具体业务流程集中在这里，方便复用和测试。
 */

import { createHash, randomUUID } from "node:crypto"
import type { Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import {
  getKnowledgeAssetMediaType,
  getKnowledgeAssetStorageKey,
  isSafeKnowledgeAssetName,
} from "@/lib/knowledge/assets"
import {
  KnowledgeError,
  knowledgeDocumentNotFound,
} from "@/lib/knowledge/errors"
import {
  requireFolderInKnowledgeBase,
  requireOwnedKnowledgeBase,
  lockOwnedKnowledgeBase,
} from "@/lib/knowledge/ownership"
import { inspectKnowledgeFile } from "@/lib/knowledge/parsers/registry"
import {
  extractMarkdownSections,
  markdownToPlainText,
  normalizeText,
  titleFromFilename,
} from "@/lib/knowledge/parsers/normalize"
import type {
  SaveKnowledgeDocumentContentInput,
  ReparseKnowledgeDocumentInput,
  RenameKnowledgeDocumentInput,
} from "@/lib/knowledge/schemas"
import { cancelDocumentJobs } from "@/lib/knowledge/service"
import {
  deleteOssObject,
  getOssObject,
  putOssObject,
  getOssPreviewUrl,
} from "@/lib/storage/oss"

// 文档详情接口统一使用的字段集合，避免把 storageKey 等内部字段返回给前端。
const documentDetailSelect = {
  id: true,
  knowledgeBaseId: true,
  folderId: true,
  title: true,
  type: true,
  source: true,
  status: true,
  originalFileName: true,
  mimeType: true,
  sizeBytes: true,
  checksumSha256: true,
  markdownContent: true,
  plainText: true,
  revision: true,
  contentRevision: true,
  parserVersion: true,
  parseMetadata: true,
  parseErrorCode: true,
  parseErrorMessage: true,
  parsedAt: true,
  chunkStatus: true,
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

export const createKnowledgeDocumentUpload = async ({
  userId,
  knowledgeBaseId,
  folderId,
  filename,
  mimeType,
  buffer,
}: {
  userId: string
  knowledgeBaseId: string
  folderId: string | null
  filename: string
  mimeType: string
  buffer: Buffer
}) => {
  // 先规范文件名并检查扩展名、MIME 和文件签名是否属于支持的格式。
  const originalFileName = sanitizeFilename(filename)
  const inspected = inspectKnowledgeFile({
    buffer,
    filename: originalFileName,
    mimeType,
  })

  // 上传前确认知识库和目标文件夹归属当前用户。
  await prisma.$transaction(async (db) => {
    await requireOwnedKnowledgeBase(db, userId, knowledgeBaseId)
    if (folderId)
      await requireFolderInKnowledgeBase(db, knowledgeBaseId, folderId)
  })

  // 文档 ID 参与对象键生成，因此同名文件也不会互相覆盖。
  const id = randomUUID()
  const checksumSha256 = createHash("sha256").update(buffer).digest("hex")
  // inspectKnowledgeFile 已确认扩展名在白名单中，无需再次正则检查。
  const extension = originalFileName
    .slice(originalFileName.lastIndexOf(".") + 1)
    .toLowerCase()
  const storageKey = `knowledge-documents/${userId}/${knowledgeBaseId}/${id}.${extension}`

  // 原文件放在 OSS，数据库只保存对象键、大小和哈希。
  await putOssObject(storageKey, buffer, inspected.mimeType)
  try {
    return await prisma.$transaction(async (db) => {
      await requireOwnedKnowledgeBase(db, userId, knowledgeBaseId)
      if (folderId)
        await requireFolderInKnowledgeBase(db, knowledgeBaseId, folderId)

      // 文档记录和解析任务在同一事务中创建，避免出现没有任务的文档。
      const document = await db.knowledgeDocument.create({
        data: {
          id,
          knowledgeBaseId,
          folderId,
          title: titleFromFilename(originalFileName),
          type: inspected.documentType,
          source: "UPLOAD",
          status: "QUEUED",
          originalFileName,
          mimeType: inspected.mimeType,
          sizeBytes: buffer.byteLength,
          checksumSha256,
          storageKey,
        },
        select: documentDetailSelect,
      })

      await db.documentProcessingJob.create({
        data: {
          knowledgeBaseId,
          documentId: id,
          type: "PARSE",
          status: "PENDING",
          targetRevision: 0,
          dedupeKey: `parse:${id}:${checksumSha256}`,
          payload: {
            storageKey,
            checksumSha256,
            parserKind: inspected.kind,
          } satisfies Prisma.InputJsonObject,
        },
      })
      return document
    })
  } catch (error) {
    // 数据库写入失败时回收刚上传的文件，避免 OSS 出现孤儿对象。
    await deleteOssObject(storageKey).catch((cleanupError) => {
      console.error(
        "Failed to roll back knowledge document upload",
        cleanupError
      )
    })
    throw error
  }
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
      data: { title: input.title, revision: { increment: 1 } },
    })
    if (updated.count !== 1) throw knowledgeDocumentNotFound()
    return db.knowledgeDocument.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        knowledgeBaseId: true,
        title: true,
        revision: true,
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

/** 只登记 REPARSE 任务，Worker 成功后才替换正文并增加 contentRevision。 */
export const reparseKnowledgeDocument = async (
  userId: string,
  id: string,
  input: ReparseKnowledgeDocumentInput
) =>
  prisma.$transaction(
    async (db) => {
      const where = {
        id,
        deletedAt: null,
        knowledgeBase: { userId, deletedAt: null },
      }
      const initial = await db.knowledgeDocument.findFirst({
        where,
        select: { knowledgeBaseId: true },
      })
      if (!initial) throw knowledgeDocumentNotFound()
      await lockOwnedKnowledgeBase(db, userId, initial.knowledgeBaseId)
      const document = await db.knowledgeDocument.findFirst({
        where,
        select: { ...documentDetailSelect, storageKey: true },
      })
      if (!document) throw knowledgeDocumentNotFound()
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
      if (document.status === "QUEUED" || document.status === "PARSING")
        throw new KnowledgeError(
          "KNOWLEDGE_DOCUMENT_PROCESSING",
          "文档正在解析，请等待当前任务完成",
          409
        )

      // 与保存共用版本条件，阻止旧标签页的确认覆盖别人刚保存的正文。
      const updated = await db.knowledgeDocument.updateMany({
        where: {
          ...where,
          status: { in: ["READY", "FAILED"] },
          contentRevision: input.expectedContentRevision,
        },
        data: {
          status: "QUEUED",
          parseErrorCode: null,
          parseErrorMessage: null,
          revision: { increment: 1 },
        },
      })
      if (updated.count !== 1)
        throw new KnowledgeError(
          "CONTENT_REVISION_CONFLICT",
          "正文版本已变化，请重新加载后再确认解析",
          409
        )
      await cancelDocumentJobs(db, [id])
      await db.documentProcessingJob.create({
        data: {
          documentId: id,
          knowledgeBaseId: document.knowledgeBaseId,
          type: "REPARSE",
          status: "PENDING",
          targetRevision: document.contentRevision,
          // 失败后允许重新发起；重复点击由同库事务锁和 QUEUED 状态阻止。
          dedupeKey: `reparse:${id}:${randomUUID()}`,
          payload: {
            storageKey: document.storageKey,
            checksumSha256: document.checksumSha256,
          },
        },
      })
      return db.knowledgeDocument.findUniqueOrThrow({
        where: { id },
        select: documentDetailSelect,
      })
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 }
  )

/** 保存解析后的副本，不覆盖 OSS 原件，也不重新调用 MinerU。 */
export const saveKnowledgeDocumentContent = async (
  userId: string,
  id: string,
  input: SaveKnowledgeDocumentContentInput
) =>
  prisma.$transaction(
    async (db) => {
      const where = {
        id,
        deletedAt: null,
        knowledgeBase: { userId, deletedAt: null },
      }
      const initial = await db.knowledgeDocument.findFirst({
        where,
        select: { knowledgeBaseId: true },
      })
      if (!initial) throw knowledgeDocumentNotFound()

      // 与知识库/目录删除共用锁，等待后重新读取，避免在已删除的资源上保存。
      await lockOwnedKnowledgeBase(db, userId, initial.knowledgeBaseId)
      const document = await db.knowledgeDocument.findFirst({
        where,
        select: documentDetailSelect,
      })
      if (!document) throw knowledgeDocumentNotFound()
      if (document.status !== "READY") {
        throw new KnowledgeError(
          "KNOWLEDGE_DOCUMENT_NOT_READY",
          "文档尚未解析完成，不能保存正文",
          409
        )
      }

      const markdown = normalizeText(input.markdownContent)
      // parseMetadata 是可空的 JSON 字段；保留资源清单和解析来源，只重算正文定位。
      const metadata = document.parseMetadata
      const parseMetadata = JSON.parse(
        JSON.stringify({
          ...(metadata &&
          typeof metadata === "object" &&
          !Array.isArray(metadata)
            ? metadata
            : {}),
          sections: extractMarkdownSections(markdown),
        })
      ) as Prisma.InputJsonObject

      // 版本必须放在 UPDATE 条件中；单独读版本再无条件更新会丢失另一个标签页的修改。
      const result = await db.knowledgeDocument.updateMany({
        where: {
          ...where,
          status: "READY",
          contentRevision: input.expectedContentRevision,
        },
        data: {
          markdownContent: markdown,
          plainText: markdownToPlainText(markdown),
          parseMetadata,
          revision: { increment: 1 },
          contentRevision: { increment: 1 },
          chunkStatus: "PENDING",
          chunkedContentRevision: null,
        },
      })
      if (result.count !== 1) {
        throw new KnowledgeError(
          "CONTENT_REVISION_CONFLICT",
          "正文版本已变化，请保留草稿并重新加载最新内容",
          409
        )
      }
      return db.knowledgeDocument.findUniqueOrThrow({
        where: { id },
        select: documentDetailSelect,
      })
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 }
  )

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
