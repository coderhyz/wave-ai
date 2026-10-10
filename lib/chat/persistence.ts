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
    super("消息已经归属于其他会话")
    this.name = "MessageConflictError"
  }
}

/**
 * 获取当前用户的会话；会话不存在时创建新会话。
 *
 * createMany 配合 skipDuplicates 可以处理重复请求和并发创建。
 * 创建或跳过创建后，还会再次检查会话的 userId，保证用户只能
 * 访问自己的会话。
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

  if (!chat || chat.userId !== userId) {
    throw new ChatOwnershipError()
  }

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
  const serializedParts = toInputJson(message.parts)

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

  const storedMessage = await prisma.message.findUnique({
    where: { id: message.id },
  })

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
