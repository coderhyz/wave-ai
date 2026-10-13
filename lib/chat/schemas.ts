import { CHAT_MODEL_IDS } from "@/lib/ai/model"
import { z } from "zod"

/**
 * AI SDK 消息片段的基础结构。
 * 每个片段必须包含 type，其他字段由具体片段类型决定并原样保留。
 */
const uiMessagePartSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough()

/**
 * 客户端提交的用户消息结构。
 * 当前接口只接受 user 消息，助手消息统一由服务端模型生成。
 */
export const incomingUserMessageSchema = z
  .object({
    /** 消息唯一标识，用于避免网络重试造成重复写入。 */
    id: z.string().min(1).max(128),
    /** 发送接口只允许提交用户消息。 */
    role: z.literal("user"),
    /** 消息内容片段，至少包含一个文本或其他类型片段。 */
    parts: z.array(uiMessagePartSchema).min(1),
    /** 客户端附带的可选扩展信息。 */
    metadata: z.unknown().optional(),
  })
  .strict()

/**
 * POST /api/chat 的请求体。
 * 包含会话 ID、本轮用户消息、模型选择和预留的工具选择。
 */
export const sendChatMessageSchema = z.object({
  /** 会话 UUID；新会话可以由客户端提前生成。 */
  id: z.string().uuid(),
  /** 文档预览问答的固定范围；普通聊天省略。 */
  documentId: z.string().uuid().optional(),
  /** 本轮需要发送给模型的用户消息。 */
  message: incomingUserMessageSchema,
  /** 只能选择服务端模型白名单中存在的模型。 */
  selectedModelId: z.enum(CHAT_MODEL_IDS),
  /** 额外工具选择的预留字段；默认知识库检索无需选择，应传 null。 */
  selectedToolName: z.string().trim().min(1).max(50).nullable().default(null),
  /** 区分发送新消息和重新生成已有回复。 */
  trigger: z
    .enum(["submit-message", "regenerate-message"])
    .default("submit-message"),
})

/** GET、PATCH、DELETE 会话接口共用的路径参数。 */
export const chatIdSchema = z.object({
  /** 需要读取、修改或删除的会话 UUID。 */
  id: z.string().uuid(),
})

/** GET /api/chat 的游标分页参数。 */
export const chatListQuerySchema = z.object({
  /** 上一页最后一条会话的 ID；第一页不传。 */
  cursor: z.string().uuid().optional(),
  /** 每页数量，默认 20，最大 50。 */
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/** PATCH /api/chat/:id 的请求体。 */
export const updateChatSchema = z
  .object({
    /** 新的会话标题，去除首尾空格后长度为 1 到 80。 */
    title: z.string().trim().min(1).max(80).optional(),
    /** 是否将会话固定在历史列表顶部。 */
    isPinned: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ title, isPinned }) => title !== undefined || isPinned !== undefined,
    {
      message: "至少需要提供一个可更新字段",
    }
  )
