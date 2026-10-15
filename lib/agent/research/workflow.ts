import "server-only"

import {
  consumeStream,
  InvalidToolInputError,
  NoSuchToolError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  type UIMessageChunk,
} from "ai"
import { createResearchBudget } from "@/lib/agent/harness/budgets"
import type { ChatModelId } from "@/lib/ai/model"
import { createDeepResearchAgent } from "./execution/create-research-agent"
import { createResearchPlan, type ResearchPlan } from "./analysis/planner"
import {
  evaluateCoverage,
  selectResearchEvidence,
  type CoverageEvaluation,
} from "./analysis/evaluator"
import { generateResearchReport } from "./reporting/reporter"
import {
  DEFAULT_RESEARCH_BUDGET,
  researchOptionsSchema,
  type ResearchBudget,
  type ResearchOptions,
} from "./schemas"

export class ResearchWorkflowError extends Error {
  constructor(
    public readonly phase: "planning" | "research" | "evaluation" | "report",
    public readonly errorCode: "MODEL_FAILED" | "WORKFLOW_TIMEOUT",
    options: ErrorOptions
  ) {
    const phaseName = {
      planning: "规划",
      research: "检索",
      evaluation: "评估",
      report: "报告生成",
    }[phase]
    super(
      errorCode === "WORKFLOW_TIMEOUT"
        ? "深度研究已达到运行时限，未能完成报告。已取得的检索记录仍保留，请缩小研究范围后重试。"
        : NoObjectGeneratedError.isInstance(options.cause) ||
            NoOutputGeneratedError.isInstance(options.cause)
          ? `深度研究${phaseName}阶段失败：模型未返回符合结构要求的数据，请重试。`
          : `深度研究${phaseName}阶段失败，请稍后重试。`,
      options
    )
  }
}

export async function runResearchWorkflow(input: {
  question: string
  modelId: ChatModelId
  userId: string
  options?: ResearchOptions
  budget?: ResearchBudget
  signal?: AbortSignal
  onResearchStream?: (stream: ReadableStream<UIMessageChunk>) => Promise<void>
  onPlan?: (plan: ResearchPlan) => void
  onEvaluation?: (evaluation: CoverageEvaluation) => void
}) {
  input.signal?.throwIfAborted()
  const options = input.options ?? researchOptionsSchema.parse({})
  const limits = input.budget ?? DEFAULT_RESEARCH_BUDGET
  const budget = createResearchBudget(limits, options.depth)
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException("研究工作流超时", "TimeoutError")),
    limits.maxDurationMs
  )
  const signal = AbortSignal.any([
    controller.signal,
    ...(input.signal ? [input.signal] : []),
  ])
  const modelInput = () => ({
    modelId: input.modelId,
    signal,
    timeoutMs: Math.max(1, budget.remainingMs()),
  })
  const usage = { inputTokens: 0, outputTokens: 0 }
  const addUsage = (value?: {
    inputTokens?: number
    outputTokens?: number
  }) => {
    usage.inputTokens += value?.inputTokens ?? 0
    usage.outputTokens += value?.outputTokens ?? 0
  }
  let researchTimer: ReturnType<typeof setTimeout> | undefined
  let phase: ResearchWorkflowError["phase"] = "planning"
  try {
    const planned = await createResearchPlan({
      ...modelInput(),
      ...options,
      question: input.question,
    })
    addUsage(planned.usage)
    const plan = planned.plan
    input.onPlan?.(plan)
    // 一个请求只创建一个 Agent/Registry/Budget；补充轮次显式传入计划、证据和缺口。
    const research = createDeepResearchAgent({
      modelId: input.modelId,
      userId: input.userId,
      budget: limits,
      toolsBudget: budget,
      sourceScope: options.sourceScope,
      depth: options.depth,
    })
    const maxRounds =
      options.depth === "deep" ? 3 : options.depth === "quick" ? 1 : 2
    const evaluations: CoverageEvaluation[] = []
    let stopReason: "complete" | "round-limit" | "budget-exhausted" =
      "round-limit"
    // 检索和评估共用时间窗口，给报告及最终消息保存预留时间。
    const reportReserveMs = Math.min(
      90_000,
      Math.floor(limits.maxDurationMs / 3)
    )
    const researchController = new AbortController()
    const researchMs = Math.max(0, budget.remainingMs() - reportReserveMs)
    if (researchMs === 0)
      researchController.abort(
        new DOMException("检索时间预算已用尽", "TimeoutError")
      )
    else
      researchTimer = setTimeout(
        () =>
          researchController.abort(
            new DOMException("检索时间预算已用尽", "TimeoutError")
          ),
        researchMs
      )
    const researchSignal = AbortSignal.any([signal, researchController.signal])
    for (let round = 0; round < maxRounds && !researchSignal.aborted; round++) {
      try {
        budget.beginRound(round + 1)
        const previousEvaluation = evaluations.at(-1)
        const targetQuestions = previousEvaluation
          ? plan.questions.filter((question) =>
              previousEvaluation.missingQuestionIds.includes(question.id)
            )
          : plan.questions
        phase = "research"
        const result = await research.agent.stream({
          prompt: JSON.stringify({
            question: input.question,
            options,
            plan,
            targetQuestions,
            round: round + 1,
            sources: research.listSources(),
            evidence: selectResearchEvidence(
              research.listSources(),
              research.listEvidence()
            ),
            previousEvaluation,
            budget: budget.snapshot(),
          }),
          abortSignal: researchSignal,
          timeout: {
            totalMs: Math.max(1, budget.remainingMs() - reportReserveMs),
          },
        })
        // 转发 SDK 的 reasoning 和工具事件；ReAct 的自由文本不是最终报告。
        const stream = result
          .toUIMessageStream({
            sendStart: false,
            sendFinish: false,
            sendReasoning: true,
            sendSources: false,
            // 只公开可安全展示的分类，不透传原始校验异常或供应商响应。
            onError: (error) =>
              InvalidToolInputError.isInstance(error)
                ? "模型生成的工具参数不符合要求，本次调用未执行。请按工具定义提供参数。"
                : NoSuchToolError.isInstance(error)
                  ? "当前工具暂不可用、研究时间已用尽，或不在本次研究范围内。"
                  : "研究执行失败，请查看阶段错误信息或稍后重试。",
          })
          .pipeThrough(
            new TransformStream<UIMessageChunk, UIMessageChunk>({
              transform(chunk, writer) {
                // 内部检索截止不是用户取消，继续输出带局限说明的报告。
                if (
                  (chunk.type === "abort" || chunk.type === "error") &&
                  researchController.signal.aborted &&
                  !signal.aborted
                )
                  return
                if (
                  !["text-start", "text-delta", "text-end"].includes(chunk.type)
                )
                  writer.enqueue(chunk)
              },
            })
          )
        if (input.onResearchStream) await input.onResearchStream(stream)
        else await consumeStream({ stream })
        const [roundUsage] = await Promise.allSettled([result.totalUsage])
        if (roundUsage.status === "fulfilled") addUsage(roundUsage.value)
        researchSignal.throwIfAborted()
        // text 的 getter 同时传播模型流错误，不让失败的轮次冒充完成。
        await result.text
        if (roundUsage.status === "rejected") throw roundUsage.reason
        phase = "evaluation"
        const canContinue = round + 1 < maxRounds && research.canContinue()
        const evaluated = await evaluateCoverage({
          ...modelInput(),
          question: input.question,
          signal: researchSignal,
          timeoutMs: Math.max(1, budget.remainingMs() - reportReserveMs),
          plan,
          sources: research.listSources(),
          evidence: research.listEvidence(),
          canContinue,
          budget: budget.snapshot(),
        })
        addUsage(evaluated.usage)
        evaluations.push(evaluated.evaluation)
        input.onEvaluation?.(evaluated.evaluation)
        if (evaluated.evaluation.complete) {
          stopReason = "complete"
          break
        }
        if (!evaluated.evaluation.shouldContinue) {
          stopReason = research.canContinue()
            ? "round-limit"
            : "budget-exhausted"
          break
        }
      } catch (error) {
        signal.throwIfAborted()
        if (!researchController.signal.aborted) throw error
        stopReason = "budget-exhausted"
        break
      }
    }
    clearTimeout(researchTimer)
    signal.throwIfAborted()
    if (researchController.signal.aborted || evaluations.length === 0) {
      stopReason = "budget-exhausted"
      const previous = evaluations.at(-1)
      const evaluation: CoverageEvaluation = {
        coveredQuestionIds: previous?.coveredQuestionIds ?? [],
        missingQuestionIds:
          previous?.missingQuestionIds ??
          plan.questions.map((question) => question.id),
        contradictions: previous?.contradictions ?? [],
        complete: false,
        shouldContinue: false,
        assessmentKind: previous?.assessmentKind ?? "not-evaluated",
      }
      evaluations.push(evaluation)
      input.onEvaluation?.(evaluation)
    }
    phase = "report"
    const reported = await generateResearchReport({
      ...modelInput(),
      question: input.question,
      timeoutMs: Math.max(
        0,
        budget.remainingMs() -
          Math.min(1000, Math.floor(limits.maxDurationMs / 10))
      ),
      plan,
      sources: research.listSources(),
      evidence: research.listEvidence(),
      evaluation: evaluations[evaluations.length - 1],
      stopReason,
    })
    signal.throwIfAborted()
    addUsage(reported.usage)
    return {
      plan,
      evaluations,
      ...reported,
      usage,
      stopReason,
      budget: budget.snapshot(),
    }
  } catch (error) {
    input.signal?.throwIfAborted()
    throw new ResearchWorkflowError(
      phase,
      controller.signal.aborted ? "WORKFLOW_TIMEOUT" : "MODEL_FAILED",
      { cause: error }
    )
  } finally {
    clearTimeout(researchTimer)
    clearTimeout(timer)
  }
}
