
import type { FileUIPart } from "ai";

export const MAX_TEXT_PREVIEW_LENGTH = 100_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

type Attachment = Pick<FileUIPart, "url" | "mediaType" | "filename">;

/** 判断附件预览类型 */
export function getAttachmentPreviewKind(
  file: Pick<FileUIPart, "mediaType" | "filename">
): "image" | "text" | "document" | "unsupported" {
  const type = file.mediaType.split(";")[0].trim().toLowerCase();
  const name = file.filename ?? "";

  if (type.startsWith("image/")) return "image";

  if (
    ["application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ].includes(type) ||
    /\.(pdf|docx)$/i.test(name)
  ) return "document";

  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    /\.(txt|md|markdown|json|csv)$/i.test(name)
  ) return "text";

  return "unsupported";
}

/** 校验附件 URL，防止使用不安全的协议 */
export function getAttachmentPreviewUrl(value: string): string | null {
  const url = value.trim();

  try {
    // 允许站内相对路径
    if (url.startsWith("/") && !url.startsWith("//")) {
      return new URL(url, "https://attachment.local").origin ===
        "https://attachment.local" ? url : null;
    }

    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;

    // 允许普通 HTTP 地址和浏览器 Blob 地址
    if (["https:", "http:", "blob:"].includes(parsed.protocol)) {
      return url;
    }

    // 仅允许指定 MIME 类型的 Data URL
    if (
      parsed.protocol === "data:" &&
      /^data:(image\/[\w.+-]+|text\/[\w.+-]+|application\/(json|pdf|octet-stream|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))(?:;[^,]*)?,/i.test(url)
    ) return url;

  } catch {
    return null;
  }

  return null;
}

/** 读取附件字节，限制最大 2 MB */
async function fetchBytes(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error("附件读取失败");
  }

  if (Number(response.headers.get("content-length")) > MAX_FILE_SIZE) {
    await response.body?.cancel();
    throw new Error("文件超过 2 MB");
  }

  if (!response.body) throw new Error("附件内容为空");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > MAX_FILE_SIZE) {
        throw new Error("文件超过 2 MB");
      }

      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { });
    reader.releaseLock();
  }

  // 合并所有字节块
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/** 将文件字节转换为 Base64 */
function toBase64(bytes: Uint8Array) {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }

  return btoa(binary);
}

/** 读取 PDF / DOCX 并交给服务端解析 */
export async function readAttachmentDocument(
  file: Attachment,
  signal: AbortSignal,
  request: typeof fetch = fetch
) {
  const url = getAttachmentPreviewUrl(file.url);
  if (!url) throw new Error("附件地址无效");

  // 读取附件并转换为 Base64
  const bytes = await fetchBytes(url, signal);
  const base64 = toBase64(bytes);

  // 调用服务端文档解析接口
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";

  const response = await request(
    `${appUrl}/api/chat/attachments/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal,
      body: JSON.stringify({
        filename: file.filename,
        mediaType: file.mediaType,
        url: `data:application/octet-stream;base64,${base64}`,
      }),
    }
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("请登录后预览文档");
    }
    throw new Error("文档解析失败");
  }

  const result: unknown = await response.json();

  // 校验服务端返回的数据
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    result.text.length > MAX_TEXT_PREVIEW_LENGTH
  ) {
    throw new Error("文档预览数据无效");
  }

  return { text: result.text, truncated: false };
}

/** 直接读取 TXT / MD / JSON 等文本文件 */
export async function readAttachmentText(
  url: string,
  signal: AbortSignal
) {
  const safeUrl = getAttachmentPreviewUrl(url);
  if (!safeUrl) throw new Error("附件地址无效");

  const bytes = await fetchBytes(safeUrl, signal);
  const text = new TextDecoder().decode(bytes);

  return {
    text: text.slice(0, MAX_TEXT_PREVIEW_LENGTH),
    truncated: text.length > MAX_TEXT_PREVIEW_LENGTH,
  };
}
