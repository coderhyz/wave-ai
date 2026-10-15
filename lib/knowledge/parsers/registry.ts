/**
 * 知识库解析器注册中心。
 * 根据扩展名选择解析器，同时校验文件大小、MIME 和基础文件签名。
 */
import type { KnowledgeDocumentType } from "@/app/generated/prisma"
import { markdownParser } from "@/lib/knowledge/parsers/markdown-pass-through"
import { createMineruParser } from "@/lib/knowledge/parsers/mineru-to-markdown"
import { txtParser } from "@/lib/knowledge/parsers/txt-to-markdown"
import {
  KnowledgeParseError,
  MAX_KNOWLEDGE_FILE_BYTES,
  type KnowledgeDocumentParser,
  type KnowledgeSourceKind,
} from "@/lib/knowledge/parsers/types"

/** 文件扩展名到内部解析类型的映射。 */
const extensionKinds: Record<string, KnowledgeSourceKind> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "markdown",
  markdown: "markdown",
}

/** 内部解析类型到数据库枚举值的映射。 */
const databaseTypes: Record<KnowledgeSourceKind, KnowledgeDocumentType> = {
  pdf: "PDF",
  docx: "DOCX",
  txt: "TEXT",
  markdown: "MARKDOWN",
}

/** 浏览器未提供 MIME 时使用的默认类型。 */
const defaultMimeTypes: Record<KnowledgeSourceKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  markdown: "text/markdown",
}

/** 每种扩展名允许携带的 MIME 类型。 */
const acceptedMimeTypes: Record<KnowledgeSourceKind, Set<string>> = {
  pdf: new Set(["application/pdf"]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
  ]),
  txt: new Set(["text/plain"]),
  markdown: new Set(["text/markdown", "text/plain"]),
}

/** 所有解析器实例集中注册在这里，业务代码无需自行判断格式。 */
const parsers: Record<KnowledgeSourceKind, KnowledgeDocumentParser> = {
  pdf: createMineruParser("pdf"),
  docx: createMineruParser("docx"),
  txt: txtParser,
  markdown: markdownParser,
}

/** 从文件名取得不带点号的小写扩展名。 */
const getExtension = (filename: string) =>
  filename.split(".").at(-1)?.toLowerCase() ?? ""

/** PDF 文件开头附近必须存在标准 PDF 标识。 */
const hasPdfSignature = (buffer: Buffer) =>
  buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))

/** DOCX 本质是 ZIP，这里确认压缩包中存在 Word 主文档路径。 */
const hasDocxSignature = (buffer: Buffer) =>
  buffer.subarray(0, 2).equals(Buffer.from("PK")) &&
  buffer.includes(Buffer.from("word/document.xml"))

/** 处理流程已知内部类型时，直接取得对应解析器。 */
export const getKnowledgeParser = (kind: KnowledgeSourceKind) => parsers[kind]

/**
 * 上传阶段的统一文件检查入口。
 * 检查通过后返回解析类型、数据库类型和规范 MIME。
 */
export const inspectKnowledgeFile = ({
  buffer,
  filename,
  mimeType,
}: {
  buffer: Buffer
  filename: string
  mimeType: string
}) => {
  // 先检查与文件格式无关的通用大小限制。
  if (buffer.byteLength === 0) {
    throw new KnowledgeParseError("PARSE_FAILED", "不能上传空文件")
  }
  if (buffer.byteLength > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new KnowledgeParseError(
      "FILE_TOO_LARGE",
      `知识库文件不能超过 ${MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024} MB`,
      413
    )
  }

  // 扩展名决定解析器；不在白名单中的文件直接拒绝。
  const kind = extensionKinds[getExtension(filename)]
  if (!kind) {
    throw new KnowledgeParseError(
      "UNSUPPORTED_FILE_TYPE",
      "仅支持 PDF、DOCX、TXT 和 Markdown 文件"
    )
  }

  // MIME 用于发现明显伪装文件，但允许通用二进制类型。
  const claimedMimeType = mimeType.toLowerCase().split(";")[0].trim()
  if (
    claimedMimeType &&
    claimedMimeType !== "application/octet-stream" &&
    !acceptedMimeTypes[kind].has(claimedMimeType)
  ) {
    throw new KnowledgeParseError(
      "FILE_SIGNATURE_MISMATCH",
      "文件 MIME 类型与扩展名不一致"
    )
  }

  // 对 PDF 和 DOCX 再做一个成本很低的内容签名检查。
  if (kind === "pdf" && !hasPdfSignature(buffer)) {
    throw new KnowledgeParseError(
      "FILE_SIGNATURE_MISMATCH",
      "文件扩展名为 PDF，但内容不是有效 PDF"
    )
  }
  if (kind === "docx" && !hasDocxSignature(buffer)) {
    throw new KnowledgeParseError(
      "FILE_SIGNATURE_MISMATCH",
      "文件扩展名为 DOCX，但内容不是有效 Word 文档"
    )
  }

  return {
    kind,
    documentType: databaseTypes[kind],
    mimeType: claimedMimeType || defaultMimeTypes[kind],
  }
}
