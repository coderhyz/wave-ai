/**
 * Markdown 直通解析器。
 * 不重写用户正文，只处理编码、大小检查，并提取标题章节。
 */
import {
  assertMarkdownSize,
  KnowledgeParseError,
  type KnowledgeDocumentParser,
} from "@/lib/knowledge/parsers/types"
import {
  decodeTextBuffer,
  extractMarkdownSections,
} from "@/lib/knowledge/parsers/normalize"

export const markdownParser: KnowledgeDocumentParser = {
  kind: "markdown",
  version: "markdown-pass-through@1",
  async parse(input, context) {
    // Markdown 已经是目标格式，因此解码后直接作为 canonical content。
    const markdown = decodeTextBuffer(input).trim()
    if (!markdown) {
      throw new KnowledgeParseError(
        "PARSE_FAILED",
        "Markdown 文件没有可读取的正文"
      )
    }
    assertMarkdownSize(markdown)
    return {
      markdown,
      metadata: {
        format: "markdown",
        originalFileName: context.filename,
      },
      sections: extractMarkdownSections(markdown),
      warnings: [],
    }
  },
}
