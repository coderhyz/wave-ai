import { CHAT_MODEL_IDS } from "@/lib/ai/model"
import { z } from "zod"

const uiMessagePartSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough()

export const incomingUserMessageSchema = z
  .object({
    id: z.string().min(1).max(128),
    role: z.literal("user"),
    parts: z.array(uiMessagePartSchema).min(1),
    metadata: z.unknown().optional(),
  })
  .strict()

export const sendChatMessageSchema = z.object({
  id: z.string().uuid(),
  message: incomingUserMessageSchema,
  selectedModelId: z.enum(CHAT_MODEL_IDS),
  selectedToolName: z.string().trim().min(1).max(50).nullable().default(null),
})

export const chatIdSchema = z.object({
  id: z.string().uuid(),
})

export const chatListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const updateChatSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
  })
  .strict()
