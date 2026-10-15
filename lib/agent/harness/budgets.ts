import "server-only"

import type {
  ResearchBudget,
  ResearchOptions,
} from "@/lib/agent/research/schemas"

export const RESEARCH_LIMITS = {
  quick: {
    maxSearches: 3,
    searchesPerRound: 3,
    maxFetches: 6,
    stepsPerRound: 12,
  },
  standard: {
    maxSearches: 8,
    searchesPerRound: 4,
    maxFetches: 12,
    stepsPerRound: 18,
  },
  deep: {
    maxSearches: 14,
    searchesPerRound: 6,
    maxFetches: 20,
    stepsPerRound: 24,
  },
} as const

type ResearchToolName = "webSearch" | "searchKnowledge" | "fetchWebPage"
type ResearchErrorCode =
  | "TIME_BUDGET_EXCEEDED"
  | "TOOL_TIMEOUT"
  | "TOOL_FAILED"
  | "SOURCE_NOT_ALLOWED"
  | "NOT_CONFIGURED"
  | "INVALID_RESPONSE"
  | "EMPTY_CONTENT"
  | "RESPONSE_TOO_LARGE"
  | "CONCURRENCY_EXCEEDED"
  | "BUDGET_EXCEEDED"

export function researchToolError(errorCode: ResearchErrorCode, error: string) {
  return { success: false as const, errorCode, error }
}

/** 每次请求独立计数；首次 await 前检查并占用调用配额和并发名额。 */
export function createResearchBudget(
  budget: ResearchBudget,
  depth: ResearchOptions["depth"] = "standard"
) {
  const limits = RESEARCH_LIMITS[depth]
  const deadline = Date.now() + budget.maxDurationMs
  const calls = { webSearch: 0, searchKnowledge: 0, fetchWebPage: 0 }
  let activeExtracts = 0
  let researchSteps = 0
  let searchesThisRound = 0
  let currentRound = 0
  const remainingMs = () => Math.max(0, deadline - Date.now())
  const searchCount = () => calls.webSearch + calls.searchKnowledge
  const canSearch = (nextRound = false) =>
    remainingMs() > 0 &&
    searchCount() < limits.maxSearches &&
    (nextRound || searchesThisRound < limits.searchesPerRound)
  const canFetch = () =>
    remainingMs() > 0 &&
    calls.fetchWebPage < limits.maxFetches &&
    activeExtracts < budget.maxConcurrentExtracts

  return {
    remainingMs,
    beginRound(round: number) {
      currentRound = round
      searchesThisRound = 0
    },
    recordResearchStep() {
      researchSteps += 1
    },
    snapshot: () => ({
      calls: { ...calls },
      searchCount: searchCount(),
      searchesThisRound,
      currentRound,
      limits,
      researchSteps,
      remainingMs: remainingMs(),
    }),
    availableTools: ({ nextRound = false } = {}) =>
      (Object.keys(calls) as ResearchToolName[]).filter((name) =>
        name === "fetchWebPage" ? canFetch() : canSearch(nextRound)
      ),
    async execute<T>(
      name: ResearchToolName,
      abortSignal: AbortSignal | undefined,
      execute: (signal: AbortSignal) => Promise<T>
    ) {
      abortSignal?.throwIfAborted()
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return researchToolError("TIME_BUDGET_EXCEEDED", "研究运行时间已达上限")
      }
      if (
        name === "fetchWebPage" &&
        activeExtracts >= budget.maxConcurrentExtracts
      ) {
        return researchToolError("CONCURRENCY_EXCEEDED", "网页读取并发已达上限")
      }
      const isSearch = name !== "fetchWebPage"
      if (isSearch ? !canSearch() : !canFetch()) {
        return researchToolError(
          "BUDGET_EXCEEDED",
          "该工具的研究调用预算已用尽"
        )
      }
      calls[name] += 1
      if (isSearch) searchesThisRound += 1
      if (name === "fetchWebPage") activeExtracts += 1
      const controller = new AbortController()
      const timer = setTimeout(
        () =>
          controller.abort(new DOMException("研究工具超时", "TimeoutError")),
        Math.min(budget.toolTimeoutMs, remainingMs)
      )
      const signal = AbortSignal.any([
        controller.signal,
        ...(abortSignal ? [abortSignal] : []),
      ])
      let onAbort: () => void = () => {}
      try {
        // Prisma 查询不能取消；race 及时结束工具等待，后续网络阶段继续检查同一信号。
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener("abort", onAbort, { once: true })
        })
        const result = await Promise.race([execute(signal), aborted])
        signal.throwIfAborted()
        return result
      } catch (error) {
        // 用户取消交给 SDK 结束整条流；单个工具超时允许模型说明局限。
        abortSignal?.throwIfAborted()
        return researchToolError(
          controller.signal.aborted ? "TOOL_TIMEOUT" : "TOOL_FAILED",
          controller.signal.aborted
            ? "研究工具超时"
            : error instanceof Error
              ? error.message
              : "研究工具执行失败"
        )
      } finally {
        if (name === "fetchWebPage") activeExtracts -= 1
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
      }
    },
  }
}
