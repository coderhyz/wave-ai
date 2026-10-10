import "server-only"

import { createHash, randomUUID } from "node:crypto"
import type { FileUIPart, UIMessage } from "ai"
import { HTTPException } from "hono/http-exception"
import prisma from "@/lib/prisma"
import {
  decodeAttachmentDataUrl,
  extractDocumentText,
  getDocumentKind,
  MAX_DOCUMENT_TEXT_LENGTH,
} from "@/lib/chat/model-attachments"
import { deleteOssObject, getOssObject, putOssObject } from "@/lib/storage/oss"

const CHAT_ATTACHMENT_URL_PREFIX = "/api/chat/attachments/"
const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])
const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
])

const extensionMediaTypes: Record<string, string> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webp: "image/webp",
}

const normalizeMediaType = (mediaType: string, filename: string) => {
  const claimed = mediaType.toLowerCase().split(";")[0].trim()
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? ""
  return claimed || extensionMediaTypes[extension] || "application/octet-stream"
}

const hasValidImageSignature = (buffer: Buffer, mediaType: string) => {
  if (mediaType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  }
  if (mediaType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }
  if (mediaType === "image/gif") {
    return ["GIF87a", "GIF89a"].includes(
      buffer.subarray(0, 6).toString("ascii")
    )
  }
  if (mediaType === "image/webp") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    )
  }
  return false
}

const getTextContent = (buffer: Buffer) => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim()
  } catch {
    throw new HTTPException(400, { message: "文本附件必须使用 UTF-8 编码" })
  }
  if (text.length > MAX_DOCUMENT_TEXT_LENGTH) {
    throw new HTTPException(413, {
      message: "文档文字超过 100,000 字符，请拆分后上传",
    })
  }
  return text
}

const safeStorageExtension = (filename: string) => {
  const extension = filename.split(".").at(-1)?.toLowerCase()
  return extension && /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ""
}

export const getChatAttachmentUrl = (id: string) =>
  `${CHAT_ATTACHMENT_URL_PREFIX}${id}`

export const getChatAttachmentId = (url: string) => {
  if (!url.startsWith(CHAT_ATTACHMENT_URL_PREFIX)) return null
  const id = url.slice(CHAT_ATTACHMENT_URL_PREFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id
  )
    ? id
    : null
}

export const uploadChatAttachment = async ({
  userId,
  file,
}: {
  userId: string
  file: Pick<FileUIPart, "url" | "mediaType" | "filename">
}) => {
  const filename = file.filename?.trim().slice(0, 255) || "未命名附件"
  const mediaType = normalizeMediaType(file.mediaType, filename)
  const buffer = decodeAttachmentDataUrl(file.url)
  const kind = getDocumentKind({ filename, mediaType })

  let extractedText: string | null = null
  if (IMAGE_MEDIA_TYPES.has(mediaType)) {
    if (!hasValidImageSignature(buffer, mediaType)) {
      throw new HTTPException(400, { message: "图片内容与文件类型不匹配" })
    }
  } else if (kind) {
    extractedText = await extractDocumentText(buffer, { filename, mediaType })
  } else if (TEXT_MEDIA_TYPES.has(mediaType)) {
    extractedText = getTextContent(buffer)
  } else {
    throw new HTTPException(400, {
      message: "支持图片、PDF、DOCX、TXT、Markdown、JSON 和 CSV 文件",
    })
  }

  const id = randomUUID()
  const storageKey = `chat-attachments/${userId}/${id}${safeStorageExtension(filename)}`
  const checksumSha256 = createHash("sha256").update(buffer).digest("hex")

  await putOssObject(storageKey, buffer, mediaType)
  try {
    const attachment = await prisma.chatAttachment.create({
      data: {
        id,
        userId,
        storageKey,
        filename,
        mediaType,
        sizeBytes: buffer.byteLength,
        checksumSha256,
        extractedText,
      },
      select: {
        id: true,
        filename: true,
        mediaType: true,
        sizeBytes: true,
      },
    })
    return { ...attachment, url: getChatAttachmentUrl(attachment.id) }
  } catch (error) {
    await deleteOssObject(storageKey).catch((cleanupError) => {
      console.error("Failed to roll back OSS attachment upload", cleanupError)
    })
    throw error
  }
}

export const getOwnedChatAttachment = async (userId: string, id: string) => {
  const attachment = await prisma.chatAttachment.findFirst({
    where: { id, userId },
  })
  if (!attachment) {
    throw new HTTPException(404, { message: "Attachment not found" })
  }
  return attachment
}

export const readOwnedChatAttachment = async (userId: string, id: string) => {
  const attachment = await getOwnedChatAttachment(userId, id)
  const content = await getOssObject(attachment.storageKey)
  const checksum = createHash("sha256").update(content).digest("hex")
  if (
    content.byteLength !== attachment.sizeBytes ||
    checksum !== attachment.checksumSha256
  ) {
    throw new Error(`OSS 附件完整性校验失败：${attachment.id}`)
  }
  return { attachment, content }
}

export const createStoredAttachmentResolver = (userId: string) => {
  const cache = new Map<
    string,
    Promise<{ buffer: Buffer | null; text: string | null }>
  >()

  return (file: Pick<FileUIPart, "url">) => {
    const id = getChatAttachmentId(file.url)
    if (!id) return Promise.resolve(null)

    let pending = cache.get(id)
    if (!pending) {
      pending = (async () => {
        const attachment = await getOwnedChatAttachment(userId, id)
        const buffer = attachment.extractedText
          ? null
          : await getOssObject(attachment.storageKey)
        if (
          buffer &&
          (buffer.byteLength !== attachment.sizeBytes ||
            createHash("sha256").update(buffer).digest("hex") !==
              attachment.checksumSha256)
        ) {
          throw new Error(`OSS 附件完整性校验失败：${attachment.id}`)
        }
        return {
          buffer,
          text: attachment.extractedText,
        }
      })()
      cache.set(id, pending)
    }
    return pending
  }
}

const getAttachmentIds = (message: Pick<UIMessage, "parts">) => [
  ...new Set(
    message.parts.flatMap((part) => {
      if (part.type !== "file") return []
      const id = getChatAttachmentId(part.url)
      return id ? [id] : []
    })
  ),
]

export const claimMessageAttachments = async (
  userId: string,
  message: Pick<UIMessage, "id" | "parts">
) => {
  const ids = getAttachmentIds(message)
  if (ids.length === 0) return

  const attachments = await prisma.chatAttachment.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, messageId: true },
  })
  if (
    attachments.length !== ids.length ||
    attachments.some(
      ({ messageId }) => messageId !== null && messageId !== message.id
    )
  ) {
    throw new HTTPException(400, { message: "附件不存在或已被其他消息使用" })
  }

  await prisma.chatAttachment.updateMany({
    where: { id: { in: ids }, userId, messageId: null },
    data: { messageId: message.id },
  })
}

export const deletePendingChatAttachment = async (
  userId: string,
  id: string
) => {
  const attachment = await prisma.chatAttachment.findFirst({
    where: { id, userId, messageId: null },
  })
  if (!attachment) return false

  await deleteOssObject(attachment.storageKey)
  const deleted = await prisma.chatAttachment.deleteMany({
    where: { id, userId, messageId: null },
  })
  return deleted.count === 1
}

export const deleteOssObjectsBestEffort = async (storageKeys: string[]) => {
  const results = await Promise.allSettled(storageKeys.map(deleteOssObject))
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `Failed to delete OSS object ${storageKeys[index]}`,
        result.reason
      )
    }
  })
}
