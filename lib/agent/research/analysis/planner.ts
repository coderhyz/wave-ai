import "server-only"

import { generateText, Output } from "ai"
import { z } from "zod"
import { getChatGenerationSettings, myProvider } from "@/lib/ai/provider"
import type { ChatModelId } from "@/lib/ai/model"
import type { ResearchOptions } from "../schemas"

export const researchPlanSchema = z
  .object({
    goal: z.string().min(5).max(500),
    questions: z
      .array(
        z
          .object({
            id: z.string().regex(/^Q[1-6]$/),
            question: z.string().min(1).max(500),
            queries: z.array(z.string().min(1).max(200)).min(1).max(4),
            completionCriteria: z.string().min(1).max(500),
          })
          .strict()
      )
      .min(2)
      .max(6),
    scopeNotes: z.array(z.string().max(500)).max(5),
  })
  .strict()
  .refine(
    (plan) =>
      new Set(plan.questions.map((q) => q.id)).size === plan.questions.length,
    "子问题 ID 必须唯一"
  )

export type ResearchPlan = z.infer<typeof researchPlanSchema>
export type ResearchModelInput = {
  modelId: ChatModelId
  signal: AbortSignal
  timeoutMs: number
}

export async function createResearchPlan(
  input: ResearchModelInput & ResearchOptions & { question: string }
) {
  input.signal.throwIfAborted()
  // DeepSeek shares its output limit between reasoning and the JSON response.
  const settings = getChatGenerationSettings(input.modelId, { reasoning: false })
  const result = await generateText({
    model: myProvider.languageModel(input.modelId),
    ...settings,
    // 限制输出长度，避免模型生成过长的内容
    maxOutputTokens: Math.min(settings.maxOutputTokens, 2048),
    maxRetries: 0,
    // 设置中止信号
    abortSignal: input.signal,
    timeout: { totalMs: input.timeoutMs },

    // 定义输出格式
    output: Output.object(
      {
        schema: researchPlanSchema
      }),
    system:
      "围绕用户最终要得到的成果，将问题拆成 2~6 个检索子问题，ID 使用 Q1~Q6，提供搜索词和完成标准。查询应覆盖不同信息需求，避免同义重复；保留必要的不同角度、反证和时效核查，不为减少查询而遗漏研究范围。goal 和 scopeNotes 必须保留用户要求的交付形式、学习基础、周期、语言和格式。学习路线的检索应服务于阶段顺序、学习目标、练习和验收，而非仅收集概念解释。遵守深度、时效和来源范围。只规划，不回答外部事实，不输出私有思维链。",
    prompt: JSON.stringify({
      question: input.question,
      depth: input.depth,
      timeRange: input.timeRange,
      sourceScope: input.sourceScope,
    }),
  })
  return {
    plan: result.output,
    usage: result.totalUsage
  }
}
