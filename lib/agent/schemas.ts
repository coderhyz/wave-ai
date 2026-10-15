import { z } from "zod"
import { incomingUserMessageSchema, sendChatMessageSchema } from "@/lib/chat/schemas"
import { researchModeSchema, researchOptionsSchema } from "@/lib/agent/research/schemas"

/**
 * POST /api/agent/runs 的请求入口校验。
 * id 是现有会话 ID；阶段一的运行仍由一次 HTTP 请求承载。
 * 复用聊天的模型白名单与触发类型，仅允许文字 parts，拒绝附件和额外顶层字段。
 */
export const sendAgentMessageSchema = sendChatMessageSchema
  .pick({ id: true, selectedModelId: true, trigger: true })
  .extend({
    mode: researchModeSchema.default("web"),
    research: researchOptionsSchema.optional(),
    message: incomingUserMessageSchema.extend({
      // 限制单段长度和片段数量；至少一段包含实际文字，拒绝全空白问题。
      parts: z.array(z.object({
        type: z.literal("text"),
        text: z.string().min(1).max(8000),
      }).strict()).min(1).max(10)
        .refine((parts) => parts.some((part) => part.text.trim().length > 0), "问题不能为空"),
    }),
  }).strict()
