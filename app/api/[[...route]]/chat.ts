import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { HTTPException } from "hono/http-exception"
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
 * 把业务层或数据库层抛出的错误转换成前端容易处理的 HTTP 错误。
 * 已知错误映射为明确状态码；未知错误统一记录日志并返回 500，避免暴露内部细节。
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
 * 聊天接口路由。它在 route.ts 中挂载到 `/api/chat`：
 * - POST   /api/chat      发送消息并以数据流返回模型回复
 * - POST   /api/chat/attachments/preview  提取 PDF / DOCX 文字用于预览
 * - GET    /api/chat      分页获取当前用户的会话列表
 * - GET    /api/chat/:id  获取指定会话及全部消息
 * - PATCH  /api/chat/:id  修改标题或置顶状态
 * - DELETE /api/chat/:id  删除会话
 */
export const chatRoute = new Hono()
  /** PDF / DOCX 的文字预览与模型使用同一套解析器，并且必须登录。 */
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
  /**
   * 发送用户消息。
   * 执行顺序：验证登录态 -> 校验请求体 -> 保存用户消息 -> 调用模型 -> 返回流 -> 保存 AI 回复。
   */
  .post(
    "/",
    getAuthUser,
    bodyLimit({ maxSize: 10 * 1024 * 1024 }),
    zValidator("json", sendChatMessageSchema),
    async (c) => {
      try {
        // user 由 getAuthUser 写入上下文；请求体已经通过 sendChatMessageSchema 校验。
        const user = c.get("user")
        const {
          id,
          message: rawMessage,
          selectedModelId: requestedModelId,
          selectedToolName,
          trigger,
        } = c.req.valid("json")

        // 当前版本尚未接入工具调用，显式拒绝可以避免参数被静默忽略。
        if (selectedToolName !== null) {
          throw new HTTPException(400, {
            message: "所选择的工具暂不支持",
          })
        }

        // Zod 负责校验请求外形；AI SDK 继续检查 UIMessage.parts 等消息语义。
        const [message] = await validateUIMessages<UIMessage>({
          messages: [rawMessage],
        })

        const hasImageInput = message.parts.some(
          (part) => part.type === "file" && part.mediaType.startsWith("image/")
        )
        // DeepSeek 等纯文本模型无法看图；服务端再次兜底切换到视觉模型。
        const selectedModelId = resolveChatModelId(
          requestedModelId,
          hasImageInput
        )

        // 在写库前校验附件，避免不支持或超限的内容成为无法继续处理的历史消息。
        const prepareMessagesForModel = createAttachmentPreparer()
        await prepareMessagesForModel([message])

        // 首条消息会创建会话；已有会话则检查它是否确实属于当前用户。
        await getOrCreateOwnedChat({
          id,
          userId: user.id,
          modelId: selectedModelId,
          firstMessage: message,
        })

        // 使用消息 ID 幂等保存，防止网络重试造成同一条用户消息重复入库。
        const savedUserMessage = await saveMessageOnce({
          chatId: id,
          message,
          modelId: selectedModelId,
          metadata: message.metadata,
        })

        // 模型需要完整上下文，因此按创建时间正序读取该会话的全部消息。
        let storedMessages = await prisma.message.findMany({
          where: { chatId: id },
          orderBy: { createdAt: "asc" },
        })

        // 消息已存在通常意味着重复请求，也可能是用户要求从这条消息重新生成。
        if (!savedUserMessage.created) {
          const messageIndex = storedMessages.findIndex(
            (storedMessage) => storedMessage.id === message.id
          )

          if (trigger === "regenerate-message") {
            // 删除目标用户消息之后的旧回答，再从该位置生成新的回答分支。
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
            // 普通重试只允许重复提交最后一条消息，避免意外改写中间历史。
            throw new HTTPException(409, {
              message: "This message has already been processed",
            })
          }
        }

        // 将数据库记录恢复成 UIMessage，并在送入模型前再次验证持久化数据。
        const uiMessages = await validateUIMessages<UIMessage>({
          messages: storedMessages.map(toUIMessage),
        })

        // 整个助手回复共用该时间戳，使流中的 metadata 与最终落库数据一致。
        const assistantCreatedAt = new Date().toISOString()

        // streamText 会立即返回流式结果对象，模型生成过程随后持续进行。
        const result = streamText({
          // 根据已校验的模型 ID，从 Provider Registry 中选出实际语言模型。
          model: myProvider.languageModel(selectedModelId),
          // 系统提示词只由服务端注入，不允许客户端覆盖。
          instructions: CHAT_SYSTEM_PROMPT,
          // 模型需要完整上下文才能生成连贯回答，因此传入该会话的全部消息。
          messages: await convertToModelMessages(
            await prepareMessagesForModel(uiMessages)
          ),
          // 按实际模型设置思考预算与输出上限，客户端不能覆盖这些费用保护参数。
          ...getChatGenerationSettings(selectedModelId),
          // 浏览器停止请求或断开连接时，把取消信号传给模型调用。
          abortSignal: c.req.raw.signal,
          maxRetries: 2,
          onError: ({ error }) => {
            console.error("Chat model stream failed", error)
          },
        })

        // 转换成前端 useChat 可以直接解析的 UI Message Stream。
        const uiMessageStream = toUIMessageStream({
          stream: result.stream,
          // 原始上下文帮助 AI SDK 正确衔接本次新增的助手消息。
          originalMessages: uiMessages,
          // 助手消息 ID 由服务端生成，流结束后使用同一个 ID 保存。
          generateMessageId: () => crypto.randomUUID(),
          // 推理过程和来源会作为独立的 message part 发送给前端。
          sendReasoning: true,
          sendSources: true,
          // metadata 会跟随助手消息传输，并在刷新页面后从数据库恢复。
          messageMetadata: () => ({
            createdAt: assistantCreatedAt,
            modelId: selectedModelId,
          }),
          // 流正常结束或被用户停止后，保存已生成内容、结束原因和 token 用量。
          onEnd: async ({ responseMessage, isAborted, finishReason }) => {
            try {
              /**
               * 中止发生在模型正常结束之前时，usage Promise 可能拒绝。
               * allSettled 可以保证部分回复仍然落库；正常完成时则继续暴露异常。
               */
              const [usageResult] = await Promise.allSettled([result.usage])

              if (!isAborted) {
                if (usageResult.status === "rejected") {
                  throw usageResult.reason
                }
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

              // 记录会话最近使用的模型；Prisma 会同时自动刷新 updatedAt。
              await prisma.chat.updateMany({
                where: { id, userId: user.id },
                data: { modelId: selectedModelId },
              })
            } catch (error) {
              console.error("Failed to persist the assistant message", error)
              throw error
            }
          },
          // 流式响应阶段发生错误时，返回一段可以直接展示给用户的文本。
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
  /**
   * 获取当前用户的会话列表。
   * 使用 cursor 游标分页，并额外多取一条来判断是否还有下一页。
   */
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
          // 置顶会话优先；同为置顶时按置顶时间排序，其余按最近更新排序。
          orderBy: [
            { isPinned: "desc" },
            { pinnedAt: "desc" },
            { updatedAt: "desc" },
            { id: "desc" },
          ],
          // 多查询一条不会返回给客户端，只用于计算 hasMore。
          take: limit + 1,
          // 有 cursor 时从对应记录继续查询；skip: 1 用于排除 cursor 本身。
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
        // 如果查询结果数量大于 limit，则说明还有更多数据，返回 nextCursor 供前端分页使用
        const hasMore = chats.length > limit
        // 如果有更多数据，则截取前 limit 条数据返回给前端
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
  /** 获取指定会话详情，并把数据库消息转换成前端使用的 UIMessage。 */
  .get("/:id", getAuthUser, zValidator("param", chatIdSchema), async (c) => {
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")

      // userId 必须参与查询，确保用户不能读取其他人的会话。
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
  /** 修改会话标题或置顶状态；请求体可以只提供其中一个字段。 */
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

        // 把 userId 直接放进更新条件，避免先查询再更新产生越权窗口。
        const result = await prisma.chat.updateMany({
          where: { id, userId: user.id },
          data: {
            // undefined 表示本次不更新该字段，而不是把字段清空。
            ...(title !== undefined ? { title } : {}),
            ...(isPinned !== undefined
              ? {
                isPinned,
                // 取消置顶时同时清空 pinnedAt，保证列表排序数据一致。
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
  /** 删除当前用户拥有的会话；关联消息会根据 Prisma 关系配置级联删除。 */
  .delete("/:id", getAuthUser, zValidator("param", chatIdSchema), async (c) => {
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")

      // 同样把 userId 放进删除条件，确保用户只能删除自己的会话。
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
