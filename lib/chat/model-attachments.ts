import type { UIMessage } from "ai"
import { fromBufferPromise } from "yauzl"
import mammoth from "mammoth"
import { HTTPException } from "hono/http-exception"

/** 原始附件、解压内容、页数和最终模型文本分别设置上限，避免资源耗尽。 */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
export const MAX_DOCUMENT_TEXT_LENGTH = 100_000
const MAX_PDF_PAGES = 50
const MAX_DOCX_EXPANDED_BYTES = 20 * 1024 * 1024
const MAX_DOCX_ENTRY_BYTES = 5 * 1024 * 1024
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

type AttachmentInfo = { mediaType: string; filename?: string }

/** MIME 不可靠时使用文件扩展名兜底，只把 PDF 和 DOCX 当作可解析文档。 */
export function getDocumentKind(file: AttachmentInfo): "pdf" | "docx" | null {
  const mediaType = file.mediaType.toLowerCase().split(";")[0].trim()
  if (mediaType === "application/pdf" || /\.pdf$/i.test(file.filename ?? ""))
    return "pdf"
  if (mediaType === DOCX_MEDIA_TYPE || /\.docx$/i.test(file.filename ?? ""))
    return "docx"
  return null
}

/** 仅接收浏览器上传的字节，不在服务端抓取用户指定的 URL。 */
export function decodeAttachmentDataUrl(url: string): Buffer {
  // 拒绝 http/file 等地址，避免服务端替用户访问内网或本地文件。
  if (!url.startsWith("data:"))
    throw new HTTPException(400, { message: "文件附件必须使用 data URL" })
  if (url.length > MAX_ATTACHMENT_BYTES * 3 + 256)
    throw new HTTPException(413, { message: "单个附件不能超过 2 MB" })
  const separator = url.indexOf(",")
  if (separator < 0)
    throw new HTTPException(400, { message: "附件内容格式无效" })
  const metadata = url.slice(5, separator)
  const encoded = url.slice(separator + 1)
  let content: Buffer
  try {
    // Data URL 既可能使用 base64，也可能使用百分号编码的 UTF-8 文本。
    if (/;base64$/i.test(metadata)) {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded
        )
      )
        throw new Error("Invalid base64")
      content = Buffer.from(encoded, "base64")
    } else {
      content = Buffer.from(decodeURIComponent(encoded), "utf8")
    }
  } catch {
    throw new HTTPException(400, { message: "无法读取附件内容" })
  }
  // URL 字符长度只能快速拦截，解码后还要按真实字节数再次检查。
  if (content.byteLength > MAX_ATTACHMENT_BYTES)
    throw new HTTPException(413, { message: "单个附件不能超过 2 MB" })
  return content
}

/** DOCX 是 ZIP：先逐项限量解压验证，防止小压缩包在解析时膨胀。 */
async function validateDocxArchive(buffer: Buffer) {
  const zip = await fromBufferPromise(buffer, { validateEntrySizes: true })
  const names = new Set<string>()
  let declaredBytes = 0
  let actualBytes = 0
  try {
    // 同时限制条目数量、单条大小、声明总大小和实际读取总大小。
    if (zip.entryCount > 500)
      throw new HTTPException(413, {
        message: "DOCX 结构过于复杂，请拆分后上传",
      })
    for await (const entry of zip.eachEntry()) {
      // 重复路径可能使不同 ZIP 解析器读取到不一致内容，因此直接拒绝。
      if (names.has(entry.fileName))
        throw new HTTPException(400, {
          message: "DOCX 包含重复文件，无法安全解析",
        })
      names.add(entry.fileName)
      declaredBytes += entry.uncompressedSize
      if (
        entry.uncompressedSize > MAX_DOCX_ENTRY_BYTES ||
        declaredBytes > MAX_DOCX_EXPANDED_BYTES
      )
        throw new HTTPException(413, {
          message: "DOCX 解压后过大，请拆分后上传",
        })
      if (entry.fileName.endsWith("/")) continue
      const stream = await zip.openReadStreamPromise(entry)
      try {
        // 不完全信任 ZIP 头声明，实际解压读取时继续累计字节数。
        for await (const chunk of stream) {
          actualBytes += chunk.length
          if (actualBytes > MAX_DOCX_EXPANDED_BYTES)
            throw new HTTPException(413, {
              message: "DOCX 解压后过大，请拆分后上传",
            })
        }
      } finally {
        stream.destroy()
      }
    }
    // 这两个文件是最小 DOCX 结构，缺少时通常只是改了扩展名的 ZIP。
    if (!names.has("[Content_Types].xml") || !names.has("word/document.xml"))
      throw new HTTPException(400, { message: "文件不是有效的 DOCX 文档" })
  } finally {
    zip.close()
  }
}

/** 逐页提取 PDF 文字，并在读取过程中持续检查页数和字符数限制。 */
async function extractPdfText(buffer: Buffer) {
  if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new HTTPException(400, { message: "文件不是有效的 PDF 文档" })
  // Worker / Canvas 仅在 Node 服务端加载，不把解析器打包进前端。
  await import("pdf-parse/worker")
  const { PDFParse } = await import("pdf-parse")
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    verbosity: 0,
  })
  try {
    const info = await parser.getInfo()
    if (info.total > MAX_PDF_PAGES)
      throw new HTTPException(413, {
        message: "PDF 最多支持 50 页，请拆分后上传",
      })
    let text = ""
    // 按页提取并检查长度，不把整份大型文档一次性放进模型上下文。
    for (let page = 1; page <= info.total; page++) {
      const result = await parser.getText({ partial: [page], pageJoiner: "" })
      text += result.text + "\n\n"
      if (text.length > MAX_DOCUMENT_TEXT_LENGTH)
        throw new HTTPException(413, {
          message: "文档文字超过 100,000 字符，请拆分后上传",
        })
    }
    return text
  } finally {
    await parser.destroy()
  }
}

/** PDF/DOCX 只提取文字；不会执行文档脚本，也不会访问外部链接。 */
export async function extractDocumentText(
  buffer: Buffer,
  file: AttachmentInfo
) {
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES)
    throw new HTTPException(413, { message: "单个附件不能超过 2 MB" })
  const kind = getDocumentKind(file)
  if (!kind)
    throw new HTTPException(400, { message: "仅支持 PDF、DOCX 文档解析" })
  try {
    let text: string
    if (kind === "pdf") {
      text = await extractPdfText(buffer)
    } else {
      // 先验证 ZIP 结构和解压上限，再交给 Mammoth 提取纯文本。
      await validateDocxArchive(buffer)
      // 只传 Buffer，不提供文件路径；Mammoth 默认禁用外部文件访问。
      text = (await mammoth.extractRawText({ buffer })).value
    }
    // 清理二进制文档中偶尔出现的空字符，避免污染模型上下文。
    text = text.replace(/\u0000/g, "").trim()
    if (!text)
      throw new HTTPException(400, {
        message:
          kind === "pdf"
            ? "PDF 未提取到文字，可能是扫描件；请先 OCR 或上传可选中文字的 PDF"
            : "DOCX 未提取到文字，文档中的图片暂不支持 OCR",
      })
    if (text.length > MAX_DOCUMENT_TEXT_LENGTH)
      throw new HTTPException(413, {
        message: "文档文字超过 100,000 字符，请拆分后上传",
      })
    return text
  } catch (error) {
    // 已分类的业务错误保持具体状态码和文案。
    if (error instanceof HTTPException) throw error
    if (error instanceof Error && error.name === "PasswordException")
      throw new HTTPException(400, { message: "PDF 已加密，请移除密码后上传" })
    throw new HTTPException(400, {
      message: "文档解析失败，请确认文件未损坏且格式为 PDF 或 DOCX",
    })
  }
}

/**
 * 每个请求各自缓存提取结果：写库前验证和组装历史上下文时不重复解析。
 * 图片保留 file part，其他附件转换为文本；数据库仍保留原文件用于预览。
 */
export function createAttachmentPreparer() {
  // 缓存只存在于当前请求：同一附件“写库前校验”和“生成前转换”只解析一次。
  const cache = new Map<string, Promise<string>>()
  return async (messages: UIMessage[]): Promise<UIMessage[]> => {
    const prepared: UIMessage[] = []
    for (const message of messages) {
      // 限制的是单条消息附件数，历史中的不同消息可以各自包含附件。
      if (message.parts.filter((part) => part.type === "file").length > 3)
        throw new HTTPException(400, { message: "一条消息最多包含 3 个附件" })
      const parts: UIMessage["parts"] = []
      for (const part of message.parts) {
        if (part.type !== "file") {
          parts.push(part)
          continue
        }
        if (
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            part.mediaType
          )
        ) {
          // 视觉模型可以直接读取图片，所以保留原 file part。
          if (
            part.url.startsWith("data:") &&
            part.url.length > MAX_ATTACHMENT_BYTES * 1.5
          )
            throw new HTTPException(413, { message: "单个附件不能超过 2 MB" })
          parts.push(part)
          continue
        }
        const kind = getDocumentKind(part)
        // 非文档附件只允许明确的文本格式，二进制格式不能直接塞进提示词。
        if (
          !kind &&
          !(
            part.mediaType.startsWith("text/") ||
            part.mediaType === "application/json" ||
            /\.(csv|json|md|markdown|txt)$/i.test(part.filename ?? "")
          )
        )
          throw new HTTPException(400, {
            message: "支持图片、PDF、DOCX、TXT、Markdown、JSON 和 CSV 文件",
          })
        const key = (kind ?? "text") + ":" + part.url
        let pending = cache.get(key)
        if (!pending) {
          const buffer = decodeAttachmentDataUrl(part.url)
          pending = kind
            ? extractDocumentText(buffer, part)
            : Promise.resolve(buffer.toString("utf8"))
          cache.set(key, pending)
        }
        const content = await pending
        const filename = part.filename ?? "未命名附件"
        // 用清晰边界包住附件文字，降低模型把附件和用户正文混淆的概率。
        parts.push({
          type: "text",
          text:
            "\n\n--- 附件「" +
            filename +
            "」内容开始 ---\n" +
            content +
            "\n--- 附件「" +
            filename +
            "」内容结束 ---",
        })
      }
      // 创建新消息对象，数据库里保存的原始 file part 不会被原地修改。
      prepared.push({ ...message, parts })
    }
    return prepared
  }
}
