import { isToolUIPart, getToolName, type UIMessage } from "ai"
import { z } from "zod"
import { getKnowledgeCitationHref, getKnowledgeCitations } from "./citations"

const searchOutputSchema = z.object({
  success: z.literal(true),
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      snippet: z.string(),
      publishedAt: z.string().nullable().optional(),
    })
  ),
})

export type ChatSource = {
  id: string
  url: string
  title: string
  domain: string
  snippet: string
  kind: "search-summary" | "knowledge-chunk"
  publishedAt?: string | null
}

/** 来源只取助手消息中已登记的链接和现有引用，不从生成文本推测外部来源。 */
export function getChatSources(message?: UIMessage): ChatSource[] {
  if (!message || message.role !== "assistant") return []
  const snippets = new Map<
    string,
    { title: string; snippet: string; publishedAt?: string | null }
  >()
  for (const part of message.parts) {
    if (
      !isToolUIPart(part) ||
      getToolName(part) !== "webSearch" ||
      part.state !== "output-available" ||
      part.preliminary
    )
      continue
    const output = searchOutputSchema.safeParse(part.output)
    if (output.success)
      for (const result of output.data.results) snippets.set(result.url, result)
  }
  const sources = new Map<string, ChatSource>()
  function addWebSource(rawUrl: string, title?: string, sourceId?: string) {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return
    }
    if (!["http:", "https:"].includes(url.protocol)) return
    url.hash = ""
    if (sources.has(url.href)) return
    const detail = snippets.get(rawUrl) ?? snippets.get(url.href)
    sources.set(url.href, {
      id: sourceId ?? url.href,
      url: url.href,
      title: title || url.hostname,
      domain: url.hostname.replace(/^www\./, ""),
      snippet: detail?.snippet ?? "",
      kind: "search-summary",
      publishedAt: detail?.publishedAt,
    })
  }

  for (const part of message.parts) {
    if (part.type === "source-url")
      addWebSource(part.url, part.title, part.sourceId)
  }
  // 已登记来源优先；普通聊天也可从完成的工具输出补充来源。
  for (const [url, detail] of snippets) addWebSource(url, detail.title)
  for (const citation of getKnowledgeCitations(message)) {
    const id = `knowledge:${citation.documentId}`
    if (sources.has(id)) continue
    sources.set(id, {
      id,
      url: getKnowledgeCitationHref(citation),
      title: citation.documentTitle,
      domain: "知识库",
      snippet: citation.content,
      kind: "knowledge-chunk",
    })
  }
  return [...sources.values()]
}
