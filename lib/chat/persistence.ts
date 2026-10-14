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
  constructor(message = "消息已经归属于其他会话") {
    super(message)
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
  documentId = null,
}: {
  id: string
  userId: string
  modelId: ChatModelId
  firstMessage: UIMessage
  documentId?: string | null
}) => {
  const createResult = await prisma.chat.createMany({
    data: [
      {
        id,
        userId,
        modelId,
        title: createProvisionalTitle(firstMessage),
        documentId,
      },
    ],
    skipDuplicates: true,
  })

  const chat = await prisma.chat.findUnique({ where: { id } })

  if (!chat || chat.userId !== userId) {
    throw new ChatOwnershipError()
  }

  if ((chat.documentId ?? null) !== documentId) {
    throw new MessageConflictError("会话检索范围不匹配，请重新打开文档问答")
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
 * 核对 chatId 和 role；重复 ID 还需核对 parts，防止消息 ID 被错误复用。
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
    // 新插入的内容由本次请求确定；Prisma 写入 JSON 小数可能改变末位精度。
    // 只有重复 ID 才需要比较已有内容，防止复用消息 ID 覆盖另一条消息。
    (createResult.count === 0 &&
      !isDeepStrictEqual(storedMessage.parts, serializedParts))
  ) {
    throw new MessageConflictError()
  }

  return {
    message: storedMessage,
    created: createResult.count === 1,
  }
}

/**
 * 普通聊天和联网 Agent 共用的历史分支处理。
 * 前置条件：调用方已校验会话所有权，并通过 saveMessageOnce 保存用户消息。
 * userMessageCreated 区分新提交与已有消息；trigger 决定是否重新生成旧分支。
 * 返回保留的消息和待清理附件 Key，OSS 删除由路由在数据库删除成功后执行。
 */
export async function readChatTurn({
  chatId, userId, messageId, userMessageCreated, trigger,
}: {
  chatId: string
  userId: string
  messageId: string
  userMessageCreated: boolean
  trigger: "submit-message" | "regenerate-message"
}) {
  let messages = await prisma.message.findMany({
    where: { chatId }, orderBy: { createdAt: "asc" },
  })
  const attachmentKeys: string[] = []
  // 新问题直接使用当前历史；已存在的问题需要区分重试和重新生成。
  if (!userMessageCreated) {
    const index = messages.findIndex((message) => message.id === messageId)
    // 并发删除可能使目标消息消失，此时必须停止，避免误删其他分支。
    if (index < 0) throw new MessageConflictError("目标消息不存在，请刷新会话")
    if (trigger === "regenerate-message") {
      // 用户问题是重新生成的锚点；旧回答及其后续消息一起移除。
      const laterIds = messages.slice(index + 1).map((message) => message.id)
      if (laterIds.length > 0) {
        // 先取附件 Key，再删除消息，否则关联记录删除后无法找到 OSS 对象。
        const attachments = await prisma.chatAttachment.findMany({
          where: { messageId: { in: laterIds }, userId },
          select: { storageKey: true },
        })
        await prisma.message.deleteMany({ where: { chatId, id: { in: laterIds } } })
        attachmentKeys.push(...attachments.map(({ storageKey }) => storageKey))
        messages = messages.slice(0, index + 1)
      }
    // 非重新生成请求只能重试最后一条待回答的问题，避免重复处理历史问题。
    } else if (index !== messages.length - 1) {
      throw new MessageConflictError("This message has already been processed")
    }
  }
  return { messages, attachmentKeys }
}
