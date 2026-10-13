/**
 * TXT 转 Markdown 解析器。
 * 负责文本编码识别、Markdown 特殊符号转义，并按自然段生成定位信息。
 */
import {
  assertMarkdownSize,
  KnowledgeParseError,
  type KnowledgeDocumentParser,
  type ParsedSection,
} from "@/lib/knowledge/parsers/types"
import {
  decodeTextBuffer,
  plainTextToMarkdown,
  titleFromFilename,
} from "@/lib/knowledge/parsers/normalize"

export const txtParser: KnowledgeDocumentParser = {
  kind: "txt",
  version: "txt-to-markdown@1",
  async parse(input, context) {
    // 先把二进制文件解码成可信文本，并拒绝空文件。
    const decoded = decodeTextBuffer(input).trim()
    if (!decoded) {
      throw new KnowledgeParseError("PARSE_FAILED", "TXT 文件没有可读取的正文")
    }

    // TXT 没有文档标题结构，因此使用文件名补一个一级标题。
    const title = titleFromFilename(context.filename)
    const body = plainTextToMarkdown(decoded)
    const prefix = `# ${title}\n\n`
    const markdown = prefix + body
    assertMarkdownSize(markdown)

    // 每个由空行分隔的自然段都记录字符范围，后续可以按段分块。
    const sections: ParsedSection[] = []
    let searchFrom = prefix.length
    body.split(/\n{2,}/).forEach((paragraph, index) => {
      const startOffset = markdown.indexOf(paragraph, searchFrom)
      const endOffset = startOffset + paragraph.length
      sections.push({
        startOffset,
        endOffset,
        locator: { paragraph: index + 1 },
      })
      searchFrom = endOffset
    })

    return {
      markdown,
      metadata: {
        format: "text",
        originalFileName: context.filename,
        paragraphCount: sections.length,
      },
      sections,
      warnings: [],
    }
  },
}
