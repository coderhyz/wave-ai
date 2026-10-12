/** 单个知识库原文件允许的最大字节数：20 MB。 */
export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024
/** 转换完成后的 Markdown 最大字符数，避免超大正文进入数据库。 */
export const MAX_MARKDOWN_CHARACTERS = 2_000_000

/** 知识库当前支持的四种源文件类型。 */
export type KnowledgeSourceKind = "pdf" | "docx" | "txt" | "markdown"

/** 解析阶段可能返回给任务系统和前端的稳定错误码。 */
export type KnowledgeParseErrorCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_SIGNATURE_MISMATCH"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TEXT_ENCODING"
  | "PARSE_TIMEOUT"
  | "PARSE_FAILED"
  | "OUTPUT_TOO_LARGE"

/** 原文定位信息，用于从 Markdown 章节或 Chunk 回到原文位置。 */
export interface ParseLocator {
  page?: number
  headingPath?: string[]
  paragraph?: number
}

/** 一段 Markdown 在完整正文中的字符范围及其来源位置。 */
export interface ParsedSection {
  startOffset: number
  endOffset: number
  locator: ParseLocator
}

/** 所有解析器都必须返回的统一结果。 */
export interface ParsedMarkdownDocument {
  markdown: string
  plainText: string
  metadata: Record<string, unknown>
  sections: ParsedSection[]
  warnings: string[]
}

/** Worker 调用解析器时提供的文件信息和可选图片上传能力。 */
export interface ParseContext {
  filename: string
  mimeType: string
  uploadAsset?: (asset: {
    data: Buffer
    mediaType: "image/jpeg" | "image/png" | "image/webp"
  }) => Promise<string>
}

/** PDF、DOCX、TXT、Markdown 解析器共同遵守的接口。 */
export interface KnowledgeDocumentParser {
  kind: KnowledgeSourceKind
  version: string
  parse(input: Buffer, context: ParseContext): Promise<ParsedMarkdownDocument>
}

/** 可识别、可重试并能安全展示给用户的解析错误。 */
export class KnowledgeParseError extends Error {
  constructor(
    readonly code: KnowledgeParseErrorCode,
    message: string,
    readonly status: 400 | 413 = 400,
    readonly retryable = false
  ) {
    super(message)
    this.name = "KnowledgeParseError"
  }
}

/** 在写入数据库前检查 Markdown 是否超过统一上限。 */
export const assertMarkdownSize = (markdown: string) => {
  if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
    throw new KnowledgeParseError(
      "OUTPUT_TOO_LARGE",
      "解析后的 Markdown 过大，请拆分文件后重新上传",
      413
    )
  }
}
