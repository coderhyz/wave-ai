import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type UIMessage,
} from "ai"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { myProvider } from "@/lib/ai/provider"
import { CHAT_SYSTEM_PROMPT } from "@/lib/ai/prompts"
import {
  chatIdSchema,
  chatListQuerySchema,
  sendChatMessageSchema,
  updateChatSchema,
} from "@/lib/chat/schemas"
import { toUIMessage } from "@/lib/chat/mapper"
import {
  ChatOwnershipError,
  getOrCreateOwnedChat,
  MessageConflictError,
  saveMessageOnce,
} from "@/lib/chat/persistence"
import prisma from "@/lib/prisma"

const throwApiError = (error: unknown, fallbackMessage: string): never => {
  if (error instanceof HTTPException) {
    throw error
  }

  if (error instanceof ChatOwnershipError) {
    throw new HTTPException(404, { message: "Chat not found" })
  }

  if (error instanceof MessageConflictError) {
    throw new HTTPException(409, { message: error.message })
  }

  console.error(fallbackMessage, error)
  throw new HTTPException(500, { message: fallbackMessage })
}

export const chatRoute = new Hono()
  .post(
    "/",
    getAuthUser,
    zValidator("json", sendChatMessageSchema),
    async (c) => {
      try {
        const user = c.get("user")
        const {
          id,
          message: rawMessage,
          selectedModelId,
          selectedToolName,
        } = c.req.valid("json")

        if (selectedToolName !== null) {
          throw new HTTPException(400, {
            message: "Tools are not available yet",
          })
        }

        const [message] = await validateUIMessages<UIMessage>({
          messages: [rawMessage],
        })

        await getOrCreateOwnedChat({
          id,
          userId: user.id,
          modelId: selectedModelId,
          firstMessage: message,
        })

        const savedUserMessage = await saveMessageOnce({
          chatId: id,
          message,
          metadata: message.metadata,
        })

        const storedMessages = await prisma.message.findMany({
          where: { chatId: id },
          orderBy: { createdAt: "asc" },
        })

        if (!savedUserMessage.created) {
          const messageIndex = storedMessages.findIndex(
            (storedMessage) => storedMessage.id === message.id
          )

          if (messageIndex !== storedMessages.length - 1) {
            throw new HTTPException(409, {
              message: "This message has already been processed",
            })
          }
        }

        const uiMessages = await validateUIMessages<UIMessage>({
          messages: storedMessages.map(toUIMessage),
        })
        const assistantCreatedAt = new Date().toISOString()

        const result = streamText({
          model: myProvider.languageModel(selectedModelId),
          system: CHAT_SYSTEM_PROMPT,
          messages: convertToModelMessages(uiMessages),
          abortSignal: c.req.raw.signal,
          maxRetries: 2,
          onError: ({ error }) => {
            console.error("Chat model stream failed", error)
          },
        })

        return result.toUIMessageStreamResponse({
          originalMessages: uiMessages,
          generateMessageId: () => crypto.randomUUID(),
          sendReasoning: true,
          sendSources: true,
          messageMetadata: () => ({
            createdAt: assistantCreatedAt,
            modelId: selectedModelId,
          }),
          onFinish: async ({ responseMessage, isAborted }) => {
            try {
              const [finishReason, usage] = await Promise.all([
                result.finishReason,
                result.totalUsage,
              ])

              await saveMessageOnce({
                chatId: id,
                message: responseMessage,
                modelId: selectedModelId,
                metadata: {
                  createdAt: assistantCreatedAt,
                  modelId: selectedModelId,
                  isAborted,
                },
                finishReason,
                promptTokens: usage.inputTokens ?? null,
                completionTokens: usage.outputTokens ?? null,
              })

              await prisma.chat.updateMany({
                where: { id, userId: user.id },
                data: { modelId: selectedModelId },
              })
            } catch (error) {
              console.error("Failed to persist the assistant message", error)
              throw error
            }
          },
          onError: (error) => {
            console.error("Chat response stream failed", error)
            return "生成回复失败，请稍后重试。"
          },
        })
      } catch (error) {
        throwApiError(error, "Failed to send chat message")
      }
    }
  )
  .get(
    "/",
    getAuthUser,
    zValidator("query", chatListQuerySchema),
    async (c) => {
      try {
        const user = c.get("user")
        const { cursor, limit } = c.req.valid("query")
        const chats = await prisma.chat.findMany({
          where: { userId: user.id },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor
            ? {
              cursor: { id: cursor },
              skip: 1,
            }
            : {}),
          select: {
            id: true,
            title: true,
            modelId: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: { messages: true },
            },
          },
        })
        const hasMore = chats.length > limit
        const items = hasMore ? chats.slice(0, limit) : chats

        return c.json({
          success: true,
          items,
          nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
        })
      } catch (error) {
        throwApiError(error, "Failed to retrieve chats")
      }
    }
  )
  .get("/:id", getAuthUser, zValidator("param", chatIdSchema), async (c) => {
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")
      const chat = await prisma.chat.findFirst({
        where: { id, userId: user.id },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      })

      if (!chat) {
        throw new HTTPException(404, {
          message: "Chat not found",
        })
      }

      const { messages, ...chatData } = chat

      return c.json({
        success: true,
        chat: chatData,
        messages: messages.map(toUIMessage),
      })
    } catch (error) {
      throwApiError(error, "Failed to retrieve chat")
    }
  })
  .patch(
    "/:id",
    getAuthUser,
    zValidator("param", chatIdSchema),
    zValidator("json", updateChatSchema),
    async (c) => {
      try {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const { title } = c.req.valid("json")
        const result = await prisma.chat.updateMany({
          where: { id, userId: user.id },
          data: { title },
        })

        if (result.count === 0) {
          throw new HTTPException(404, {
            message: "Chat not found",
          })
        }

        const chat = await prisma.chat.findUnique({ where: { id } })

        return c.json({ success: true, chat })
      } catch (error) {
        throwApiError(error, "Failed to update chat")
      }
    }
  )
  .delete("/:id", getAuthUser, zValidator("param", chatIdSchema), async (c) => {
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")
      const result = await prisma.chat.deleteMany({
        where: { id, userId: user.id },
      })

      if (result.count === 0) {
        throw new HTTPException(404, {
          message: "Chat not found",
        })
      }

      return c.json({ success: true })
    } catch (error) {
      throwApiError(error, "Failed to delete chat")
    }
  })
