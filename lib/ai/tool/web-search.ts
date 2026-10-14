import { tool } from "ai"
import {
  tavilySearchProvider,
  webSearchInputSchema,
  type SearchInput,
} from "@/lib/agent/providers/search-provider"

/**
 * 普通聊天工具和联网 Agent 共用的搜索执行函数。
 * Provider 负责请求；这里把普通失败转换为 success:false，交给模型说明失败、UI 显示原因。
 * 用户中止仍然抛出，让 SDK 结束循环，避免把“停止生成”误当成普通搜索失败。
 */
export async function executeWebSearch(
  input: SearchInput,
  { abortSignal }: { abortSignal?: AbortSignal }
) {
  try {
    const results = await tavilySearchProvider.search(input, abortSignal)
    return {
      success: true as const,
      query: input.query,
      // 数字 id 仅用于本次结果编号；消息的 sourceId 由 Agent 另外生成。
      results: results.map((item, index) => ({ id: index + 1, ...item })),
      source: "Tavily",
    }
  } catch (error) {
    abortSignal?.throwIfAborted()
    return {
      success: false as const,
      error: error instanceof Error ? error.message : "联网搜索失败",
    }
  }
}

// AI SDK 根据描述决定何时使用工具，并用 inputSchema 校验模型生成的参数。
export const webSearch = tool({
  description:
    "搜索互联网上的最新信息、技术文档、新闻和公开资料。" +
    "当问题需要实时信息或外部事实核实时使用。返回摘要及来源链接。",
  inputSchema: webSearchInputSchema,
  execute: executeWebSearch,
})
