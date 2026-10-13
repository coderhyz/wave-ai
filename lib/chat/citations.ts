import type { UIMessage } from "ai"
import { z } from "zod"

// 流式消息和历史 JSON 在展示入口投影成引用所需字段。
const citationSchema = z.object({
  chunkId: z.string(),
  documentId: z.string().uuid(),
  knowledgeBaseId: z.string().uuid(),
  documentTitle: z.string(),
  content: z.string(),
  contentRevision: z.number().int(),
  chunkIndex: z.number().int().nonnegative(),
})
const resultSchema = z.object({ items: z.array(citationSchema) })
const savedIdsSchema = z.object({ citationChunkIds: z.array(z.string()) })

/** 引用必须来自本条消息已完成的检索；历史分块引用仍保留原始依据。 */
export function getKnowledgeCitations(message: UIMessage) {
  if (message.role !== "assistant") return []
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  const chunks = new Map<string, z.infer<typeof citationSchema>>()
  for (const part of message.parts) {
    if (
      !(
        part.type === "tool-searchKnowledge" ||
        (part.type === "dynamic-tool" && part.toolName === "searchKnowledge")
      ) ||
      part.state !== "output-available" ||
      part.preliminary
    )
      continue
    const result = resultSchema.safeParse(part.output)
    if (!result.success) continue
    for (const chunk of result.data.items) chunks.set(chunk.chunkId, chunk)
  }
  const saved = savedIdsSchema.safeParse(message.metadata)
  const ids = saved.success
    ? saved.data.citationChunkIds
    : Array.from(
        text.matchAll(
          /chunkId\s*:\s*\x60?([a-zA-Z0-9_-]+)|\[(?:\\.|[^\]\\\n])*\]\(knowledge:\/\/document\/([a-zA-Z0-9_-]+)\)/g
        )
      ).flatMap((match) =>
        match[1]
          ? [match[1]]
          : Array.from(chunks.values())
              .filter((chunk) => chunk.documentId === match[2])
              .map((chunk) => chunk.chunkId)
      )
  return Array.from(new Set(ids)).flatMap((id) => {
    const chunk = chunks.get(id)
    return chunk ? [chunk] : []
  })
}

export function getKnowledgeCitationHref(
  citation: Pick<
    z.infer<typeof citationSchema>,
    "knowledgeBaseId" | "documentId"
  >
) {
  return (
    "/home?" +
    new URLSearchParams({
      base: citation.knowledgeBaseId,
      document: citation.documentId,
    })
  )
}

/** 展示、复制和导出都使用文档链接，不暴露历史回答里的分块标识。 */
export function formatKnowledgeCitationText(
  text: string,
  citations: ReturnType<typeof getKnowledgeCitations>
) {
  const documents = new Map(citations.map((item) => [item.documentId, item]))
  const chunks = new Map(citations.map((item) => [item.chunkId, item]))
  const documentLink = (citation: (typeof citations)[number]) =>
    "[" +
    citation.documentTitle
      .replace(/\s+/g, " ")
      .replace(/([\\[\]\x60*_<>])/g, "\\$1") +
    "](" +
    getKnowledgeCitationHref(citation) +
    ")"

  let formatted = text.replace(
    /\[((?:\\.|[^\]\\\n])*)\]\(knowledge:\/\/document\/([a-zA-Z0-9_-]+)\)/g,
    (_match, title: string, id: string) => {
      const citation = documents.get(id)
      return citation ? documentLink(citation) : title
    }
  )
  for (const citation of citations) {
    const title = citation.documentTitle.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&")
    formatted = formatted.replace(
      new RegExp(
        title +
          "\\s*[（(]\\s*chunkId\\s*:\\s*\\x60?" +
          citation.chunkId +
          "\\x60?\\s*[)）]",
        "g"
      ),
      () => documentLink(citation)
    )
  }
  formatted = formatted.replace(
    /[（(]?[ \t]*chunkId\s*:\s*\x60?([a-zA-Z0-9_-]+)\x60?[)）]?/g,
    (match, id: string) => {
      const citation = chunks.get(id)
      return citation ? documentLink(citation) : match
    }
  )
  // 同一来源括号中引用了多个分块时，文档标题只保留一次。
  return formatted.replace(
    /[（(]?[ \t]*来源\s*[:：]\s*((?:\[(?:\\.|[^\]\\\n])*\]\(\/home\?[^)\n]+\)(?:[ \t]*[、，,；;][ \t]*)?)+)[ \t]*[)）]?/g,
    (_match, links: string) =>
      Array.from(
        new Set(links.match(/\[(?:\\.|[^\]\\\n])*\]\(\/home\?[^)\n]+\)/g))
      ).join(" · ")
  )
}
