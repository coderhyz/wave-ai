import { z } from "zod"

export const researchModeSchema = z.enum(["web", "deep-research"])

export const researchOptionsSchema = z
  .object({
    depth: z.enum(["quick", "standard", "deep"]).default("standard"),
    timeRange: z.string().trim().min(1).max(200).optional(),
    sourceScope: z.enum(["all", "web", "knowledge"]).default("all"),
  })
  .strict()
export type ResearchOptions = z.infer<typeof researchOptionsSchema>

/** 仅供服务端配置；HTTP 请求不接收预算或用户 ID。 */
export const researchBudgetSchema = z
  .object({
    maxConcurrentExtracts: z.number().int().min(1).max(2).default(2),
    maxDurationMs: z.number().int().positive().max(300_000).default(300_000),
    toolTimeoutMs: z.number().int().positive().max(15_000).default(15_000),
  })
  .strict()

export type ResearchBudget = z.infer<typeof researchBudgetSchema>
export const DEFAULT_RESEARCH_BUDGET = researchBudgetSchema.parse({})
