import "server-only"

import type { UIMessage } from "ai"
import { HTTPException } from "hono/http-exception"
import {
  decodeAttachmentDataUrl,
  extractDocumentText,
  getDocumentKind,
  MAX_DOCUMENT_TEXT_LENGTH,
} from "@/lib/chat/model-attachments"

type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>
type StoredAttachmentResolver = (
  file: FilePart
) => Promise<{ buffer: Buffer | null; text: string | null } | null>

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

/**
 * 将数据库中的稳定附件地址转换成模型可消费的内容。
 * 图片仅在本次模型请求中恢复为 Data URL，文档直接复用上传时提取的文本。
 */
export function createStoredAttachmentPreparer(
  resolveStoredAttachment: StoredAttachmentResolver
) {
  const textCache = new Map<string, Promise<string>>()

  return async (messages: UIMessage[]): Promise<UIMessage[]> => {
    const prepared: UIMessage[] = []
    for (const message of messages) {
      if (message.parts.filter((part) => part.type === "file").length > 3) {
        throw new HTTPException(400, { message: "一条消息最多包含 3 个附件" })
      }

      const parts: UIMessage["parts"] = []
      for (const part of message.parts) {
        if (part.type !== "file") {
          parts.push(part)
          continue
        }

        const stored = await resolveStoredAttachment(part)
        if (IMAGE_MEDIA_TYPES.has(part.mediaType)) {
          if (stored) {
            if (!stored.buffer) {
              throw new HTTPException(500, { message: "无法读取图片附件" })
            }
            parts.push({
              ...part,
              url: `data:${part.mediaType};base64,${stored.buffer.toString("base64")}`,
            })
          } else {
            // 兼容迁移前已经保存的 Data URL，并拒绝任意远程 URL。
            decodeAttachmentDataUrl(part.url)
            parts.push(part)
          }
          continue
        }

        const kind = getDocumentKind(part)
        if (
          !kind &&
          !(
            part.mediaType.startsWith("text/") ||
            part.mediaType === "application/json" ||
            /\.(csv|json|md|markdown|txt)$/i.test(part.filename ?? "")
          )
        ) {
          throw new HTTPException(400, {
            message: "支持图片、PDF、DOCX、TXT、Markdown、JSON 和 CSV 文件",
          })
        }

        const cacheKey = `${kind ?? "text"}:${part.url}`
        let pendingText = textCache.get(cacheKey)
        if (!pendingText) {
          if (stored?.text !== null && stored?.text !== undefined) {
            pendingText = Promise.resolve(stored.text)
          } else {
            const buffer = stored?.buffer ?? decodeAttachmentDataUrl(part.url)
            pendingText = kind
              ? extractDocumentText(buffer, part)
              : Promise.resolve(buffer.toString("utf8"))
          }
          textCache.set(cacheKey, pendingText)
        }

        const content = await pendingText
        if (content.length > MAX_DOCUMENT_TEXT_LENGTH) {
          throw new HTTPException(413, {
            message: "文档文字超过 100,000 字符，请拆分后上传",
          })
        }
        const filename = part.filename ?? "未命名附件"
        parts.push({
          type: "text",
          text: `\n\n--- 附件「${filename}」内容开始 ---\n${content}\n--- 附件「${filename}」内容结束 ---`,
        })
      }
      prepared.push({ ...message, parts })
    }
    return prepared
  }
}
