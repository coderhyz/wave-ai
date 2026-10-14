import { z } from "zod"

/** 搜索工具的输入契约；AI SDK 在调用工具前校验，Provider 内直接使用已校验参数。 */
export const webSearchInputSchema = z.object({
  query: z.string().min(2).max(300).describe("要搜索的关键词或具体问题"),
  topic: z.enum(["general", "news"]).optional().describe("普通或新闻搜索"),
  maxResults: z.number().int().min(1).max(10).optional().describe("结果数量，默认 5 条"),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
})

// 第三方响应是独立的信任边界：校验结果形状，并只接收可作为网页链接的协议。
const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol)),
    content: z.string(),
    score: z.number().optional(),
    published_date: z.string().nullable().optional(),
  })),
})

export type SearchInput = z.infer<typeof webSearchInputSchema>
/** 把 Tavily 的字段转换成应用统一结构；snippet 是搜索摘要，score 是供应商相关度。 */
export type SearchResult = {
  title: string
  url: string
  snippet: string
  score: number | null
  publishedAt: string | null
}

/** Provider 只负责搜索请求，工具执行次数、消息流和持久化由调用方处理。 */
export interface SearchProvider {
  search(input: SearchInput, abortSignal?: AbortSignal): Promise<SearchResult[]>
}

/** 固定调用 Tavily Search；返回成功结果，配置、HTTP 或响应格式错误向上传递。 */
export const tavilySearchProvider: SearchProvider = {
  async search({ query, topic = "general", maxResults = 5, timeRange }, abortSignal) {
    abortSignal?.throwIfAborted()
    // 密钥仅在服务端使用，缺少配置时明确失败。
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) throw new Error("服务端未配置 TAVILY_API_KEY")

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // 只取搜索摘要和发布时间；最终回答由应用模型生成。
      body: JSON.stringify({
        query, topic, search_depth: "basic", max_results: maxResults,
        time_range: timeRange, include_answer: false, include_raw_content: false,
        include_published_date: true,
      }),
      // 15 秒搜索超时和用户停止共用一个信号，任一触发都会中止请求。
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(abortSignal ? [abortSignal] : []),
      ]),
    })
    if (!response.ok) throw new Error(`搜索 API 请求失败: ${response.status}`)

    // 空 results 是正常的“未找到”；缺失或错误字段会在这里抛出，不能当作空结果。
    const data = responseSchema.parse(await response.json())
    const results = new Map<string, SearchResult>()
    for (const item of data.results.slice(0, maxResults)) {
      const url = new URL(item.url)
      // 同一页面的不同锚点合并，保留查询参数，避免把不同内容页面误合并。
      url.hash = ""
      if (!results.has(url.href)) {
        // 保留供应商的结果顺序；每条摘要截到 1200 字符，控制模型上下文大小。
        results.set(url.href, {
          title: item.title, url: url.href, snippet: item.content.slice(0, 1200),
          score: item.score ?? null, publishedAt: item.published_date ?? null,
        })
      }
    }
    return [...results.values()]
  },
}
