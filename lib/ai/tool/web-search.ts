import { tool } from "ai"
import { z } from "zod"

const responseSchema = z.object({
    results: z.array(
        z.object({
            title: z.string(),
            url: z.url(),
            content: z.string(),
            score: z.number().optional(),
            published_date: z.string().nullable().optional(),
        })
    ),
})
// 网络搜索工具
export const webSearch = tool({
    description:
        "搜索互联网上的最新信息、技术文档、新闻和公开资料。" +
        "当问题需要实时信息或外部事实核实时使用此工具。" +
        "返回搜索结果及其来源链接。",

    inputSchema: z.object({
        query: z.string().min(2).max(300).describe("要搜索的关键词或具体问题"),

        topic: z
            .enum(["general", "news"])
            .optional()
            .describe("搜索类型：general 普通搜索，news 新闻搜索"),

        maxResults: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("返回搜索结果数量，默认5条"),

        timeRange: z
            .enum(["day", "week", "month", "year"])
            .optional()
            .describe("可选的发布时间范围过滤"),
    }),

    execute: async (
        { query, topic = "general", maxResults = 5, timeRange },
        { abortSignal }
    ) => {
        abortSignal?.throwIfAborted()
        const apiKey = process.env.TAVILY_API_KEY

        if (!apiKey) {
            return {
                success: false,
                error: "服务端未配置 TAVILY_API_KEY",
            }
        }

        try {
            const response = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query,
                    topic,
                    search_depth: "basic",
                    max_results: maxResults,
                    time_range: timeRange,
                    include_answer: false,
                    include_raw_content: false,
                    include_published_date: true,
                }),
                signal: AbortSignal.any([
                    AbortSignal.timeout(15000),
                    ...(abortSignal ? [abortSignal] : []),
                ]),
            })

            if (!response.ok) {
                throw new Error(`搜索 API 请求失败: ${response.status}`)
            }

            const data = responseSchema.parse(await response.json())

            return {
                success: true,
                query,
                results: data.results.map((item, i) => ({
                    id: i + 1,
                    title: item.title,
                    url: item.url,
                    snippet: item.content.slice(0, 1200),
                    score: item.score ?? null,
                    publishedAt: item.published_date ?? null,
                })),
                source: "Tavily",
            }
        } catch (error) {
            abortSignal?.throwIfAborted()
            return {
                success: false,
                error: error instanceof Error ? error.message : "联网搜索失败",
            }
        }
    },
})
