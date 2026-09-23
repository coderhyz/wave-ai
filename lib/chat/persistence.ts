import type { Role } from "@/app/generated/prisma"
import type { ChatModelId } from "@/lib/ai/model"
import prisma from "@/lib/prisma"
import type { UIMessage } from "ai"
import { isDeepStrictEqual } from "node:util"
import { createProvisionalTitle, toInputJson } from "./mapper"

/**
 * 会话归属校验失败时抛出的异常。
 * API 层会将它转换成 404，避免泄露其他用户的会话信息。
 */
export class ChatOwnershipError extends Error {
  constructor() {
    super("Chat not found")
    this.name = "ChatOwnershipError"
  }
}

/**
 * 消息 ID 与已有消息发生冲突时抛出的异常。
 * 用于阻止同一个消息 ID 被写入不同会话或保存不同内容。
 */
export class MessageConflictError extends Error {
  constructor() {
    super("Message id already belongs to another chat")
    this.name = "MessageConflictError"
  }
}

/**
 * 获取当前用户的会话；会话不存在时创建新会话。
 *
 * createMany 配合 skipDuplicates 可以处理重复请求和并发创建。
 * 创建或跳过创建后，还会再次检查会话的 userId，保证用户只能
 * 访问自己的会话。
 *
 * @param id 会话 UUID。
 * @param userId 当前登录用户 ID。
 * @param modelId 本轮对话使用的模型 ID。
 * @param firstMessage 首条用户消息，用于生成临时会话标题。
 * @returns 会话信息，以及本次是否创建了新会话。
 */
export const getOrCreateOwnedChat = async ({
  id,
  userId,
  modelId,
  firstMessage,
}: {
  id: string
  userId: string
  modelId: ChatModelId
  firstMessage: UIMessage
}) => {
  /** 尝试创建会话；ID 已存在时直接跳过，避免唯一键异常。 */
  const createResult = await prisma.chat.createMany({
    data: [
      {
        id,
        userId,
        modelId,
        title: createProvisionalTitle(firstMessage),
      },
    ],
    skipDuplicates: true,
  })

  const chat = await prisma.chat.findUnique({ where: { id } })

  /** 会话不存在或不属于当前用户时，不允许继续写入消息。 */
  if (!chat || chat.userId !== userId) {
    throw new ChatOwnershipError()
  }

  /** 会话切换模型后，保存最近一次使用的模型 ID。 */
  if (chat.modelId !== modelId) {
    await prisma.chat.update({
      where: { id },
      data: { modelId },
    })
  }

  return {
    chat: { ...chat, modelId },
    created: createResult.count === 1,
  }
}

/**
 * 幂等保存一条用户消息或助手消息。
 *
 * 相同消息 ID 的重复请求只会保存一次。写入完成后会重新读取消息，
 * 并核对 chatId、role 和 parts，防止消息 ID 被错误复用。
 *
 * @param chatId 消息所属的会话 ID。
 * @param message AI SDK 的 UIMessage 消息。
 * @param modelId 生成助手消息时使用的模型 ID。
 * @param metadata 消息扩展信息，例如生成是否被中止。
 * @param finishReason 模型结束生成的原因。
 * @param promptTokens 输入 token 数量。
 * @param completionTokens 输出 token 数量。
 * @returns 数据库消息，以及本次是否创建了新消息。
 */
export const saveMessageOnce = async ({
  chatId,
  message,
  modelId,
  metadata,
  finishReason,
  promptTokens,
  completionTokens,
}: {
  chatId: string
  message: UIMessage
  modelId?: string | null
  metadata?: unknown
  finishReason?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
}) => {
  /** 将 AI SDK 消息片段转换成 Prisma Json 字段可以保存的数据。 */
  const serializedParts = toInputJson(message.parts)

  /** 消息 ID 已存在时跳过插入，实现网络重试幂等。 */
  const createResult = await prisma.message.createMany({
    data: [
      {
        id: message.id,
        chatId,
        role: message.role as Role,
        parts: serializedParts,
        ...(metadata === undefined ? {} : { metadata: toInputJson(metadata) }),
        modelId,
        finishReason,
        promptTokens,
        completionTokens,
      },
    ],
    skipDuplicates: true,
  })

  /** 读取最终记录，用于确认已有消息与当前请求完全对应。 */
  const storedMessage = await prisma.message.findUnique({
    where: { id: message.id },
  })

  /** 任一关键字段不一致，都说明消息 ID 已被其他内容占用。 */
  if (
    !storedMessage ||
    storedMessage.chatId !== chatId ||
    storedMessage.role !== message.role ||
    !isDeepStrictEqual(storedMessage.parts, serializedParts)
  ) {
    throw new MessageConflictError()
  }

  return {
    message: storedMessage,
    created: createResult.count === 1,
  }
}
