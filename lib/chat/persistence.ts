import type { Role } from "@/app/generated/prisma"
import type { ChatModelId } from "@/lib/ai/model"
import prisma from "@/lib/prisma"
import type { UIMessage } from "ai"
import { isDeepStrictEqual } from "node:util"
import { createProvisionalTitle, toInputJson } from "./mapper"

export class ChatOwnershipError extends Error {
  constructor() {
    super("Chat not found")
    this.name = "ChatOwnershipError"
  }
}

export class MessageConflictError extends Error {
  constructor() {
    super("Message id already belongs to another chat")
    this.name = "MessageConflictError"
  }
}

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
