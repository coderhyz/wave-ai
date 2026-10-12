import "server-only"

/**
 * 知识库文档服务。
 *
 * 负责文件上传、文档记录创建、解析任务入队，以及原文件和解析资源的读取。
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
import { knowledgeDocumentNotFound } from "@/lib/knowledge/errors"
import {
  requireFolderInKnowledgeBase,
  requireOwnedKnowledgeBase,
} from "@/lib/knowledge/ownership"
import { inspectKnowledgeFile } from "@/lib/knowledge/parsers/registry"
import { titleFromFilename } from "@/lib/knowledge/parsers/normalize"
import { deleteOssObject, getOssObject, putOssObject } from "@/lib/storage/oss"

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
