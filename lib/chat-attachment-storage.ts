import "server-only"

/**
 * 聊天附件服务端存储模块：负责附件校验、OSS 读写、数据库元数据维护，
 * 以及消息发送时把附件内容解析为模型可读取的数据。
 */
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

/** 前端消息中保存的是站内访问地址，不直接暴露 OSS 对象地址。 */
const CHAT_ATTACHMENT_URL_PREFIX = "/api/chat/attachments/"
/** 允许直接作为图片附件处理的 MIME 类型。 */
const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])
/** 可以直接按 UTF-8 解码并提供给模型的纯文本类型。 */
const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
])

/** 当浏览器没有提供 MIME 类型时，根据扩展名补全文件类型。 */
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

/**
 * 统一 MIME 类型格式：去掉 charset 等参数，并在缺失时根据扩展名推断。
 * 仍无法识别的文件使用通用二进制类型，后续白名单校验会拒绝它。
 */
const normalizeMediaType = (mediaType: string, filename: string) => {
  const claimed = mediaType.toLowerCase().split(";")[0].trim()
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? ""
  return claimed || extensionMediaTypes[extension] || "application/octet-stream"
}

/**
 * 校验常见图片的文件头，防止只修改扩展名或 MIME 类型伪装成图片。
 * 这里只判断格式签名，图片尺寸和内容展示交给后续处理流程。
 */
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

/** 将文本附件严格按 UTF-8 解码，并限制提供给模型的文本长度。 */
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

/**
 * 只保留长度合理的字母数字扩展名，避免文件名中的特殊字符进入 OSS Key。
 */
const safeStorageExtension = (filename: string) => {
  const extension = filename.split(".").at(-1)?.toLowerCase()
  return extension && /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ""
}

/** 根据数据库附件 ID 生成前端可访问的站内接口地址。 */
export const getChatAttachmentUrl = (id: string) =>
  `${CHAT_ATTACHMENT_URL_PREFIX}${id}`

/** 从站内附件地址提取 UUID；外部地址或非法 ID 返回 null。 */
export const getChatAttachmentId = (url: string) => {
  if (!url.startsWith(CHAT_ATTACHMENT_URL_PREFIX)) return null
  const id = url.slice(CHAT_ATTACHMENT_URL_PREFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id
  )
    ? id
    : null
}

/**
 * 完成单个附件的服务端上传：
 * 1. 校验并解析 Data URL；2. 提取可检索文本；3. 上传 OSS；4. 保存数据库记录。
 */
export const uploadChatAttachment = async ({
  userId,
  file,
}: {
  userId: string
  file: Pick<FileUIPart, "url" | "mediaType" | "filename">
}) => {
  /** 数据库和响应中使用清理后的文件名，最长保留 255 个字符。 */
  const filename = file.filename?.trim().slice(0, 255) || "未命名附件"
  /** 不完全信任客户端声明，缺失时会结合文件扩展名推断。 */
  const mediaType = normalizeMediaType(file.mediaType, filename)
  /** 前端上传的是 Data URL，这里解码为即将写入 OSS 的原始字节。 */
  const buffer = decodeAttachmentDataUrl(file.url)
  /** PDF、DOCX 等文档类型由 model-attachments 模块统一识别。 */
  const kind = getDocumentKind({ filename, mediaType })

  /** 文档和文本预先提取内容，后续发送模型时无需重复下载、解析。 */
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

  /** UUID 同时作为数据库主键和站内附件 URL 的标识。 */
  const id = randomUUID()
  /** OSS Key 按用户分目录，避免不同用户上传的同名文件发生覆盖。 */
  const storageKey = `chat-attachments/${userId}/${id}${safeStorageExtension(filename)}`
  /** SHA-256 与文件大小共同用于下载后的完整性校验。 */
  const checksumSha256 = createHash("sha256").update(buffer).digest("hex")

  /** 先上传 OSS，再写数据库；数据库失败时由 catch 执行补偿删除。 */
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
    /** 返回站内 URL，客户端不需要知道真实的 OSS Key。 */
    return { ...attachment, url: getChatAttachmentUrl(attachment.id) }
  } catch (error) {
    /** 避免数据库写入失败后，在 OSS 中遗留无法引用的孤儿文件。 */
    await deleteOssObject(storageKey).catch((cleanupError) => {
      console.error("Failed to roll back OSS attachment upload", cleanupError)
    })
    throw error
  }
}

/** 按附件 ID 和用户 ID 联合查询，确保用户只能访问自己的附件。 */
export const getOwnedChatAttachment = async (userId: string, id: string) => {
  const attachment = await prisma.chatAttachment.findFirst({
    where: { id, userId },
  })
  if (!attachment) {
    throw new HTTPException(404, { message: "Attachment not found" })
  }
  return attachment
}

/** 下载用户附件，并通过文件大小和 SHA-256 检查 OSS 内容是否完整。 */
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

/**
 * 为一次模型请求创建附件解析器。同一附件可能在转换过程中被读取多次，
 * Promise 缓存可以合并并发读取，避免重复查询数据库或下载 OSS。
 */
export const createStoredAttachmentResolver = (userId: string) => {
  /** key 为附件 ID，value 为正在进行或已经完成的解析 Promise。 */
  const cache = new Map<
    string,
    Promise<{ buffer: Buffer | null; text: string | null }>
  >()

  return (file: Pick<FileUIPart, "url">) => {
    /** 只处理本站已经持久化的附件地址，其他 URL 交给调用方原有流程。 */
    const id = getChatAttachmentId(file.url)
    if (!id) return Promise.resolve(null)

    let pending = cache.get(id)
    if (!pending) {
      pending = (async () => {
        const attachment = await getOwnedChatAttachment(userId, id)
        /** 已提取文本的文档无需再次下载；图片等二进制附件才读取 OSS。 */
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
        /** 模型层根据 text 或 buffer 决定以文档文本还是二进制附件传入。 */
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

/** 收集消息中的站内附件 ID，并使用 Set 去重。 */
const getAttachmentIds = (message: Pick<UIMessage, "parts">) => [
  ...new Set(
    message.parts.flatMap((part) => {
      if (part.type !== "file") return []
      const id = getChatAttachmentId(part.url)
      return id ? [id] : []
    })
  ),
]

/**
 * 消息保存时将临时附件绑定到 messageId。
 * 已被其他消息绑定或不属于当前用户的附件不能再次使用。
 */
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

  /** 只更新仍处于未绑定状态的记录，避免覆盖已经建立的消息归属。 */
  await prisma.chatAttachment.updateMany({
    where: { id: { in: ids }, userId, messageId: null },
    data: { messageId: message.id },
  })
}

/**
 * 删除用户尚未绑定到消息的临时附件；已发送消息使用的附件不会被删除。
 */
export const deletePendingChatAttachment = async (
  userId: string,
  id: string
) => {
  const attachment = await prisma.chatAttachment.findFirst({
    where: { id, userId, messageId: null },
  })
  if (!attachment) return false

  /** 先删除 OSS 对象，再删除元数据，避免数据库消失后无法定位 OSS 文件。 */
  await deleteOssObject(attachment.storageKey)
  const deleted = await prisma.chatAttachment.deleteMany({
    where: { id, userId, messageId: null },
  })
  return deleted.count === 1
}

/**
 * 批量删除会话关联的 OSS 对象。单个对象失败不会阻止其他删除任务，
 * 失败项仅记录日志，适合数据库记录已经删除后的清理场景。
 */
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
