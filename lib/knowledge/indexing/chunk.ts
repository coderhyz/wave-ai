import { createHash } from "node:crypto"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"
import { extractMarkdownSections } from "@/lib/knowledge/parsers/normalize"
import type { ParseLocator, ParsedSection } from "@/lib/knowledge/parsers/types"

export interface KnowledgeChunk {
  chunkIndex: number
  content: string
  metadata: ParseLocator & {
    headingPath: string[]
    startOffset: number
    endOffset: number
  }
}

/** 同一正文版本的块在 PostgreSQL 和 ES 中共用 ID，任务重试也不会重复写入。 */
export function getKnowledgeChunkId(
  documentId: string,
  contentRevision: number,
  chunkIndex: number
) {
  return createHash("sha256")
    .update(`${documentId}:${contentRevision}:${chunkIndex}`)
    .digest("hex")
}

// 按原字符串的字符长度计数，不做 token 换算。
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 64
// markdown分块器
const markdownSeparators =
  RecursiveCharacterTextSplitter.getSeparatorsForLanguage("markdown")

// 先切出不重叠的正文，再从原文补前文，避免重复文本导致重叠位置匹配错误。
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE - CHUNK_OVERLAP,
  chunkOverlap: 0,
  keepSeparator: true,
  separators: [
    "\n# ",
    ...markdownSeparators.slice(0, -2),
    "。",
    "！",
    "？",
    "；",
    "，",
    ...markdownSeparators.slice(-2),
  ],
})

/** 不改写 Markdown；偏移采用原字符串的 UTF-16 索引，endOffset 不包含末尾字符。 */
export async function chunkMarkdown(
  markdown: string,
  sections: ParsedSection[] = extractMarkdownSections(markdown)
): Promise<KnowledgeChunk[]> {
  const ranges = [...sections]
  // 已保存的旧章节信息和 TXT 段落信息可能从标题之后开始。
  if (ranges[0]?.startOffset > 0) {
    ranges.unshift({
      startOffset: 0,
      endOffset: ranges[0].startOffset,
      locator: {},
    })
  }

  const chunks: KnowledgeChunk[] = []
  for (const section of ranges) {
    const source = markdown.slice(section.startOffset, section.endOffset)
    const parts =
      source.trim().length <= CHUNK_SIZE
        ? [source.trim()].filter(Boolean)
        : await splitter.splitText(source)
    let cursor = 0

    for (const part of parts) {
      const partStart = source.indexOf(part, cursor)
      // 引用位置必须对应真实原文；库若改变文本格式，不能保存伪造的偏移。
      if (partStart < 0) throw new Error("分块内容无法定位到原文")

      const start = Math.max(0, partStart - (cursor > 0 ? CHUNK_OVERLAP : 0))
      const rawContent = source.slice(start, partStart + part.length)
      const content = rawContent.trim()
      const startOffset =
        section.startOffset + start + rawContent.indexOf(content)
      chunks.push({
        chunkIndex: chunks.length,
        content,
        metadata: {
          ...section.locator,
          headingPath: section.locator.headingPath ?? [],
          startOffset,
          endOffset: startOffset + content.length,
        },
      })
      cursor = partStart + part.length
    }
  }
  return chunks
}
