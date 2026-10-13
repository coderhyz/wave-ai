/** 原件预览按扩展名或 MIME 分流，不使用数据库中的解析状态或解析正文。 */
export function getFilePreviewKind(filename: string, mimeType: string | null) {
  const extension = filename.split(".").at(-1)?.toLowerCase()
  // 已知扩展名优先，TXT 不应因 MIME 标签不同被当作 Markdown 渲染。
  switch (extension) {
    case "pdf":
      return "pdf"
    case "docx":
      return "docx"
    case "md":
    case "markdown":
      return "markdown"
    case "txt":
      return "text"
  }
  // MIME 只补充四种受支持文档的识别，其余类型保留下载入口。
  switch (mimeType?.split(";")[0].trim().toLowerCase()) {
    case "application/pdf":
      return "pdf"
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx"
    case "text/markdown":
      return "markdown"
    case "text/plain":
      return "text"
    default:
      return "unsupported"
  }
}

/** 只解码原始字节，保留空格、Tab 和换行；与正文解析的清理/转 Markdown 流程无关。 */
export function decodeOriginalText(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    // 现有 TXT/MD 上传允许中文 GB18030 编码，预览需显示同一份原文。
    return new TextDecoder("gb18030", { fatal: true }).decode(bytes)
  }
}
