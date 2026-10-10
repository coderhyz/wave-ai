import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessage,
} from "ai"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { getChatGenerationSettings, myProvider } from "@/lib/ai/provider"
import { resolveChatModelId } from "@/lib/ai/model"
import { CHAT_SYSTEM_PROMPT } from "@/lib/ai/prompts"
import {
  chatIdSchema,
  chatListQuerySchema,
  sendChatMessageSchema,
  updateChatSchema,
} from "@/lib/chat/schemas"
import { toUIMessage } from "@/lib/chat/mapper"
import {
  createAttachmentPreparer,
  decodeAttachmentDataUrl,
  extractDocumentText,
} from "@/lib/chat/model-attachments"
import {
  ChatOwnershipError,
  getOrCreateOwnedChat,
  MessageConflictError,
  saveMessageOnce,
} from "@/lib/chat/persistence"
import prisma from "@/lib/prisma"

/**
 * 把聊天业务或数据库错误转换成接口状态码。
 * 已知错误保留具体含义，未知错误记录日志后统一返回 500。
 */
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

/**
 * 聊天接口路由。route.ts 会把它挂载到 /api/chat：
 * POST /                 发送消息并返回流式回复
 * POST /attachments/preview  提取 PDF/DOCX 文字
 * GET /                  获取会话列表
 * GET /:id               获取会话详情
 * PATCH /:id             修改标题或置顶状态
 * DELETE /:id            删除会话
 */
export const chatRoute = new Hono()
  .post(
    "/attachments/preview",
    getAuthUser,
    bodyLimit({ maxSize: 3 * 1024 * 1024 }),
    zValidator(
      "json",
      z
        .object({
          url: z.string().max(3 * 1024 * 1024),
          mediaType: z.string().max(200),
          filename: z.string().max(255).optional(),
        })
        .strict()
    ),
    async (c) => {
      try {
        const file = c.req.valid("json")
        const text = await extractDocumentText(
          decodeAttachmentDataUrl(file.url),
          file
        )
        return c.json({ text, truncated: false })
      } catch (error) {
        return throwApiError(error, "附件预览失败")
      }
    }
  )
  .post(
    "/",
    getAuthUser,
    bodyLimit({ maxSize: 10 * 1024 * 1024 }),
    zValidator("json", sendChatMessageSchema),
    async (c) => {
      try {
        const user = c.get("user")
        const {
          id,
          message: rawMessage,
          selectedModelId: requestedModelId,
          selectedToolName,
          trigger,
        } = c.req.valid("json")

        if (selectedToolName !== null) {
          throw new HTTPException(400, {
            message: "所选择的工具暂不支持",
          })
        }

        // Zod 校验请求外形，AI SDK 继续校验 UIMessage.parts 的语义。
        const [message] = await validateUIMessages<UIMessage>({
          messages: [rawMessage],
        })

        const hasImageInput = message.parts.some(
          (part) => part.type === "file" && part.mediaType.startsWith("image/")
        )
        const selectedModelId = resolveChatModelId(
          requestedModelId,
          hasImageInput
        )

        // 同一次请求复用解析缓存，避免附件在校验和生成前重复解析。
        const prepareMessagesForModel = createAttachmentPreparer()
        await prepareMessagesForModel([message])

        // 首条消息创建会话；已有会话则检查它是否属于当前用户。
        await getOrCreateOwnedChat({
          id,
          userId: user.id,
          modelId: selectedModelId,
          firstMessage: message,
        })

        // 消息 ID 用作幂等键，网络重试不会重复插入同一条用户消息。
        const savedUserMessage = await saveMessageOnce({
          chatId: id,
          message,
          modelId: selectedModelId,
          metadata: message.metadata,
        })

        let storedMessages = await prisma.message.findMany({
          where: { chatId: id },
          orderBy: { createdAt: "asc" },
        })

        if (!savedUserMessage.created) {
          const messageIndex = storedMessages.findIndex(
            (storedMessage) => storedMessage.id === message.id
          )

          if (trigger === "regenerate-message") {
            // 重新生成时删除目标用户消息之后的旧回答和后续分支。
            const laterMessageIds = storedMessages
              .slice(messageIndex + 1)
              .map((storedMessage) => storedMessage.id)

            if (laterMessageIds.length > 0) {
              await prisma.message.deleteMany({
                where: {
                  chatId: id,
                  id: { in: laterMessageIds },
                },
              })
              storedMessages = storedMessages.slice(0, messageIndex + 1)
            }
          } else if (messageIndex !== storedMessages.length - 1) {
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
          instructions: CHAT_SYSTEM_PROMPT,
          messages: await convertToModelMessages(
            await prepareMessagesForModel(uiMessages)
          ),
          ...getChatGenerationSettings(selectedModelId),
          abortSignal: c.req.raw.signal,
          maxRetries: 2,
          onError: ({ error }) => {
            console.error("Chat model stream failed", error)
          },
        })

        const uiMessageStream = toUIMessageStream({
          stream: result.stream,
          originalMessages: uiMessages,
          generateMessageId: () => crypto.randomUUID(),
          sendReasoning: true,
          sendSources: true,
          messageMetadata: () => ({
            createdAt: assistantCreatedAt,
            modelId: selectedModelId,
          }),
          onEnd: async ({ responseMessage, isAborted, finishReason }) => {
            try {
              // 中止时 usage 可能失败，仍然保存已经生成的部分回答。
              const [usageResult] = await Promise.allSettled([result.usage])

              if (!isAborted && usageResult.status === "rejected") {
                throw usageResult.reason
              }

              const usage =
                usageResult.status === "fulfilled" ? usageResult.value : null

              await saveMessageOnce({
                chatId: id,
                message: responseMessage,
                modelId: selectedModelId,
                metadata: {
                  createdAt: assistantCreatedAt,
                  modelId: selectedModelId,
                  isAborted,
                },
                finishReason: finishReason ?? "other",
                promptTokens: usage?.inputTokens ?? null,
                completionTokens: usage?.outputTokens ?? null,
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

        return createUIMessageStreamResponse({
          stream: uiMessageStream,
          consumeSseStream: consumeStream,
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
          orderBy: [
            { isPinned: "desc" },
            { pinnedAt: "desc" },
            { updatedAt: "desc" },
            { id: "desc" },
          ],
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
            isPinned: true,
            pinnedAt: true,
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
        const { title, isPinned } = c.req.valid("json")

        const result = await prisma.chat.updateMany({
          where: { id, userId: user.id },
          data: {
            ...(title !== undefined ? { title } : {}),
            ...(isPinned !== undefined
              ? {
                  isPinned,
                  pinnedAt: isPinned ? new Date() : null,
                }
              : {}),
          },
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
