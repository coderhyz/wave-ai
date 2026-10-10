import type { FileUIPart } from "ai"

export const MAX_TEXT_PREVIEW_LENGTH = 100_000
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024

export function getAttachmentPreviewKind(
  file: Pick<FileUIPart, "mediaType" | "filename">
): "image" | "text" | "document" | "unsupported" {
  const mediaType = file.mediaType.toLowerCase().split(";")[0].trim()
  if (mediaType.startsWith("image/")) return "image"
  if (
    mediaType === "application/pdf" ||
    mediaType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.(pdf|docx)$/i.test(file.filename ?? "")
  )
    return "document"
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    /\.(txt|md|markdown|json|csv)$/i.test(file.filename ?? "")
  )
    return "text"
  return "unsupported"
}

// 支持待发送 Blob 与历史 Data URL，但不允许任意可执行 URL 协议。
export function getAttachmentPreviewUrl(value: string): string | null {
  const url = value.trim()
  if (url.startsWith("/") && !url.startsWith("//")) {
    try {
      return new URL(url, "https://attachment.local").origin ===
        "https://attachment.local"
        ? url
        : null
    } catch {
      return null
    }
  }
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return null
    if (["https:", "http:", "blob:"].includes(parsed.protocol)) return url
    if (
      parsed.protocol === "data:" &&
      /^data:(image\/[\w.+-]+|text\/[\w.+-]+|application\/(json|octet-stream|pdf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))(?:;[^,]*)?,/i.test(
        url
      )
    )
      return url
  } catch {
    return null
  }
  return null
}

/** 待发送 Blob 和历史 Data URL 均转成限量字节，交由已登录的服务端解析。 */
export async function readAttachmentDocument(
  file: Pick<FileUIPart, "url" | "mediaType" | "filename">,
  signal: AbortSignal,
  request: typeof fetch = fetch
) {
  const url = getAttachmentPreviewUrl(file.url)
  if (!url) throw new Error("附件地址无效，无法预览。")
  const response = await fetch(url, { signal, credentials: "same-origin" })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("附件读取失败，请重新选择文件后重试。")
  }
  if (Number(response.headers.get("content-length")) > MAX_TEXT_PREVIEW_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("文件超过 2 MB，无法在线预览。")
  }
  if (!response.body) throw new Error("无法读取该附件的内容。")
  const reader = response.body.getReader()
  let total = 0
  const chunks: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_TEXT_PREVIEW_BYTES)
        throw new Error("文件超过 2 MB，无法在线预览。")
      // 分块编码，避免 String.fromCharCode 大数组导致调用栈溢出。
      for (let offset = 0; offset < value.length; offset += 32_768)
        chunks.push(
          String.fromCharCode(...value.subarray(offset, offset + 32_768))
        )
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? ""
  const result = await request(appUrl + "/api/chat/attachments/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    signal,
    body: JSON.stringify({
      filename: file.filename,
      mediaType: file.mediaType,
      url: "data:application/octet-stream;base64," + btoa(chunks.join("")),
    }),
  })
  if (!result.ok) {
    if (result.status === 401) throw new Error("请登录后预览文档附件。")
    throw new Error((await result.text()).slice(0, 500) || "文档解析失败。")
  }
  const preview: unknown = await result.json()
  if (
    !preview ||
    typeof preview !== "object" ||
    !("text" in preview) ||
    typeof preview.text !== "string" ||
    preview.text.length > MAX_TEXT_PREVIEW_LENGTH
  )
    throw new Error("文档预览返回内容无效。")
  return { text: preview.text, truncated: false }
}

export async function readAttachmentText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: "same-origin" })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("附件读取失败，请重新选择文件后重试。")
  }
  if (Number(response.headers.get("content-length")) > MAX_TEXT_PREVIEW_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("文件超过 2 MB，无法在线预览。")
  }
  if (!response.body) throw new Error("无法读取该附件的内容。")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        text += decoder.decode()
        return {
          text: text.slice(0, MAX_TEXT_PREVIEW_LENGTH),
          truncated: text.length > MAX_TEXT_PREVIEW_LENGTH,
        }
      }
      bytes += value.byteLength
      if (bytes > MAX_TEXT_PREVIEW_BYTES)
        throw new Error("文件超过 2 MB，无法在线预览。")
      text += decoder.decode(value, { stream: true })
      if (text.length > MAX_TEXT_PREVIEW_LENGTH) {
        return { text: text.slice(0, MAX_TEXT_PREVIEW_LENGTH), truncated: true }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
