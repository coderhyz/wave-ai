import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessage,
  type ToolSet,
} from "ai"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { getChatGenerationSettings, myProvider } from "@/lib/ai/provider"
import { resolveChatModelId } from "@/lib/ai/model"
import { getKnowledgeCitations } from "@/lib/chat/citations"
import { CHAT_SYSTEM_PROMPT } from "@/lib/ai/prompts"
import {
  createKnowledgeListTool,
  createKnowledgeSearchTool,
} from "@/lib/ai/tool/knowledge-search"
import { getWeather } from "@/lib/ai/tool/weather"
import { webSearch } from "@/lib/ai/tool/web-search"
import {
  chatIdSchema,
  chatListQuerySchema,
  sendChatMessageSchema,
  updateChatSchema,
} from "@/lib/chat/schemas"
import { getMessageText, toUIMessage } from "@/lib/chat/mapper"
import {
  decodeAttachmentDataUrl,
  extractDocumentText,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/chat/model-attachments"
import { createStoredAttachmentPreparer } from "@/lib/chat-attachment-preparer"
import {
  claimMessageAttachments,
  createStoredAttachmentResolver,
  deleteOssObjectsBestEffort,
  deletePendingChatAttachment,
  readOwnedChatAttachment,
  uploadChatAttachment,
} from "@/lib/chat-attachment-storage"
import {
  ChatOwnershipError,
  getOrCreateOwnedChat,
  readChatTurn,
  MessageConflictError,
  saveMessageOnce,
} from "@/lib/chat/persistence"
import prisma from "@/lib/prisma"

/** 文档会话读取及发送入口都先校验当前用户的文档访问权。 */
const requireChatDocument = async (userId: string, documentId: string) => {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, deletedAt: null, knowledgeBase: { userId, deletedAt: null } },
    select: { id: true, status: true, chunkStatus: true, contentRevision: true, chunkedContentRevision: true },
  })
  if (!document) throw new HTTPException(404, { message: "文档不存在或无权访问" })
  return document
}

/** 附件路由只接受 UUID，提前拒绝非法路径参数。 */
const attachmentIdSchema = z.object({ id: z.string().uuid() }).strict()
/** 上传接口的数据结构；文件字节以 Data URL 字符串形式传入。 */
const uploadAttachmentSchema = z
  .object({
    url: z.string().max(MAX_ATTACHMENT_BYTES * 2),
    mediaType: z.string().max(200),
    filename: z.string().trim().min(1).max(255).optional(),
  })
  .strict()

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
 * POST /attachments      上传聊天附件到私有 OSS
 * GET /attachments/:id   读取属于当前用户的 OSS 附件
 * DELETE /attachments/:id 删除尚未发送的 OSS 附件
 * POST /attachments/preview  提取 PDF/DOCX 文字
 * GET /                  获取会话列表
 * GET /:id               获取会话详情
 * PATCH /:id             修改标题或置顶状态
 * DELETE /:id            删除会话
 */
export const chatRoute = new Hono()
  .get(
    "/documents/:documentId",
    getAuthUser,
    zValidator("param", z.object({ documentId: z.string().uuid() })),
    async (c) => {
      try {
        const userId = c.get("user").id
        const { documentId } = c.req.valid("param")
        await requireChatDocument(userId, documentId)
        const chat = await prisma.chat.findFirst({
          where: { userId, documentId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: { messages: { orderBy: { createdAt: "asc" } } },
        })
        c.header("Cache-Control", "private, no-store")
        if (!chat) return c.json({ success: true, chat: null, messages: [] })
        const { messages, ...chatData } = chat
        return c.json({ success: true, chat: chatData, messages: messages.map(toUIMessage) })
      } catch (error) {
        return throwApiError(error, "读取文档问答失败")
      }
    }
  )
  /** 上传附件：鉴权、限制请求体、校验参数后交给 OSS 存储模块。 */
  .post(
    "/attachments",
    getAuthUser,
    bodyLimit({ maxSize: 3 * 1024 * 1024 }),
    zValidator("json", uploadAttachmentSchema),
    async (c) => {
      try {
        /** getAuthUser 已把登录用户写入 Hono Context。 */
        const user = c.get("user")
        const attachment = await uploadChatAttachment({
          userId: user.id,
          file: c.req.valid("json"),
        })
        return c.json({ success: true, attachment }, 201)
      } catch (error) {
        return throwApiError(error, "附件上传失败")
      }
    }
  )
  /** 读取附件：存储层同时校验附件所有权和 OSS 文件完整性。 */
  .get(
    "/attachments/:id",
    getAuthUser,
    zValidator("param", attachmentIdSchema),
    async (c) => {
      try {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const { attachment, content } = await readOwnedChatAttachment(
          user.id,
          id
        )
        /**
         * filename 使用 ASCII 兜底，filename* 保留 UTF-8 原始文件名，
         * 从而兼容不同浏览器对 Content-Disposition 的解析方式。
         */
        const fallbackName = attachment.filename
          .replace(/[^\x20-\x7e]/g, "_")
          .replace(/["\\]/g, "_")
        const encodedName = encodeURIComponent(attachment.filename)

        return new Response(new Uint8Array(content), {
          headers: {
            /** 附件属于私有数据，仅允许浏览器短时间私有缓存。 */
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": `inline; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
            "Content-Length": String(content.byteLength),
            /** 禁止附件页面执行脚本或加载其他资源。 */
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Type": attachment.mediaType,
            /** 禁止浏览器自行猜测与数据库记录不同的内容类型。 */
            "X-Content-Type-Options": "nosniff",
          },
        })
      } catch (error) {
        return throwApiError(error, "附件读取失败")
      }
    }
  )
  /** 只允许删除尚未绑定到正式消息的临时附件。 */
  .delete(
    "/attachments/:id",
    getAuthUser,
    zValidator("param", attachmentIdSchema),
    async (c) => {
      try {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const deleted = await deletePendingChatAttachment(user.id, id)
        if (!deleted) {
          throw new HTTPException(404, { message: "Attachment not found" })
        }
        return c.json({ success: true })
      } catch (error) {
        return throwApiError(error, "附件删除失败")
      }
    }
  )
  /**
   * 上传前预览文档文字。该接口不持久化文件，只返回 PDF/DOCX 的解析结果。
   */
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
  /** 发送用户消息，并把模型生成结果转换成 AI SDK UIMessage 流。 */
  .post(
    "/",
    getAuthUser,
    bodyLimit({ maxSize: 10 * 1024 * 1024 }),
    zValidator("json", sendChatMessageSchema),
    async (c) => {
      try {
        const user = c.get("user")
        /** 请求已通过 sendChatMessageSchema，下面直接使用经过校验的数据。 */
        const {
          id,
          documentId,
          message: rawMessage, // UIMessage，可能包含图片或 PDF 附件
          selectedModelId: requestedModelId, // 客户端选择的模型，可能不支持视觉输入。
          webSearchEnabled, // 工具菜单的网页搜索开关，默认开启。
          selectedToolName,   // 客户端选择的额外工具；知识库检索由服务端默认提供。
          trigger,    // 触发类型：用户发送、重新生成、分支生成等。
        } = c.req.valid("json")

        /** 知识库检索默认启用；客户端选择的额外工具尚未实现。 */
        if (selectedToolName !== null) {
          throw new HTTPException(400, {
            message: "所选择的工具暂不支持",
          })
        }

        // Zod 校验请求外形，AI SDK 继续校验 UIMessage.parts 的语义。
        const [message] = await validateUIMessages<UIMessage>({
          messages: [rawMessage],
        })

        if (documentId) {
          const document = await requireChatDocument(user.id, documentId)
          if (
            document.status !== "READY" || document.chunkStatus !== "READY" ||
            document.chunkedContentRevision !== document.contentRevision
          ) throw new HTTPException(409, { message: "文档尚未完成索引，请完成后再提问" })
          if (message.parts.some((part) => part.type === "file")) {
            throw new HTTPException(400, { message: "文档问答仅支持针对当前文档的文字问题" })
          }
        }

        /** 图片输入可能要求视觉模型，因此最终模型不一定等于客户端选择。 */
        const hasImageInput = message.parts.some(
          (part) => part.type === "file" && part.mediaType.startsWith("image/")
        )
        const selectedModelId = resolveChatModelId(
          requestedModelId,
          hasImageInput
        )

        // 同一次请求复用解析缓存，避免附件在校验和生成前重复解析。
        const prepareMessagesForModel = createStoredAttachmentPreparer(
          createStoredAttachmentResolver(user.id)
        )
        await prepareMessagesForModel([message])

        // 首条消息创建会话；已有会话则检查它是否属于当前用户。
        const { chat } = await getOrCreateOwnedChat({
          id,
          userId: user.id,
          modelId: selectedModelId,
          firstMessage: message,
          documentId,
        })

        // 消息 ID 用作幂等键，网络重试不会重复插入同一条用户消息。
        const savedUserMessage = await saveMessageOnce({
          chatId: id,
          message,
          modelId: selectedModelId,
          metadata: {
            ...(message.metadata && typeof message.metadata === "object" ? message.metadata : {}),
            webSearchEnabled,
          },
        })
        // 用户消息入库后再绑定附件，避免附件被其他会话或用户占用。
        await claimMessageAttachments(user.id, message)

        /** 重新读取数据库历史，保证传给模型的是服务端认可的完整消息链。 */
        const turn = await readChatTurn({
          chatId: id, userId: user.id, messageId: message.id,
          userMessageCreated: savedUserMessage.created, trigger,
        })
        await deleteOssObjectsBestEffort(turn.attachmentKeys)
        const storedMessages = turn.messages

        const tools: ToolSet = {
          searchKnowledge: createKnowledgeSearchTool({ userId: user.id, documentId: chat.documentId ?? undefined }),
        }
        if (!chat.documentId) {
          tools.listKnowledgeDocuments = createKnowledgeListTool({ userId: user.id })
          tools.getWeather = getWeather
          tools.webSearch = webSearch
        }
        const uiMessages = await validateUIMessages<UIMessage>({
          messages: storedMessages.map(toUIMessage),
          tools,
        })
        // 校验历史仍使用完整工具集，实际生成只传本轮允许的工具，避免开关与工具列表不一致。
        const generationTools = { ...tools }
        if (!webSearchEnabled) delete generationTools.webSearch
        const canSearchWeb = "webSearch" in generationTools
        // 明确的公开时效问题必须实际检索；附件分析和固定文档问答继续遵守原范围。
        const question = getMessageText(message)
        const requiresWebSearch = canSearchWeb && !message.parts.some((part) => part.type === "file") &&
          /比赛|赛程|比分|新闻|股价|汇率|(?:最新|当前|今天|今日|实时).*(?:版本|价格|发布|更新)/.test(question) &&
          !/知识库|文档|附件/.test(question)

        /** 流开始前固定助手消息时间，流式片段和最终入库保持一致。 */
        const assistantCreatedAt = new Date().toISOString()

        // 将真实日期和工具开关明确告知模型，避免沿用训练知识中的“无法联网”回答。
        const currentDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
        const webInstructions = canSearchWeb
          ? "\n本轮服务器已提供并开启 webSearch，你可以通过该工具查询互联网。" +
            "用户询问今天的比赛、赛程、比分、最新新闻、当前版本等实时公开信息，必须先实际调用 webSearch，再依据本次结果回答。" +
            "把今天、明天等相对日期换算为上面给出的日期并写入搜索关键词。" +
            "搜索开启时，禁止在未尝试工具前回答‘没有联网能力’或直接让用户自行查询。" +
            "历史回答中关于不能联网的说法不代表本轮能力；只以本轮工具配置和实际执行结果为准。" +
            "工具失败时如实说明本次搜索失败；未命中时说明没有找到可靠信息，不编造赛程。" +
            "用户要求仅依据知识库或附件时继续遵守该范围，不向搜索服务发送私有材料。"
          : "\n本轮未开放 webSearch；需要实时网页信息时明确说明本轮没有进行网页查询，不编造结果。"

        /** streamText 负责调用选定模型，并产生服务端流式文本结果。 */
        const result = streamText({
          model: myProvider.languageModel(selectedModelId),
          instructions: CHAT_SYSTEM_PROMPT + "\n当前日期：" + currentDate + "（Asia/Shanghai）。" + webInstructions + (chat.documentId
            ? "\n本轮是文档预览问答。用户的文档内容问题仅依据当前文档检索结果回答，不使用其他知识库文档、旧回答或一般知识补齐。"
            : ""),
          /** 附件解析完成后，将 UIMessage 转换成模型供应商需要的消息格式。 */
          messages: await convertToModelMessages(
            await prepareMessagesForModel(uiMessages),
            // 停止生成可能留下未完成的工具调用，下一轮不把它发给模型。
            { tools, ignoreIncompleteToolCalls: true }
          ),
          tools: generationTools,
          stopWhen: isStepCount(3),
          // 最多两轮工具调用，最后一轮只回答，避免到达上限时仅有工具调用。
          prepareStep: ({ stepNumber }) => {
            if (stepNumber === 2) return { toolChoice: "none" }
            const firstTool = chat.documentId ? "searchKnowledge" : requiresWebSearch ? "webSearch" : undefined
            if (stepNumber === 0 && firstTool) {
              return {
                // 用 SDK 强制实际调用，不能仅靠 Prompt 要求模型联网。
                toolChoice: { type: "tool", toolName: firstTool },
                // DeepSeek 指定工具时关闭首步思考，后续总结沿用原来的思考配置。
                ...(selectedModelId === "deepseek-v4-pro"
                  ? { providerOptions: { deepseek: { thinking: { type: "disabled" } } } }
                  : {}),
              }
            }
          },
          ...getChatGenerationSettings(selectedModelId),
          abortSignal: c.req.raw.signal,
          maxRetries: 2,
          onError: ({ error }) => {
            console.error("Chat model stream failed", error)
          },
        })

        /** 将模型流转换成前端 useChat 能直接消费的 UIMessage 数据流。 */
        const uiMessageStream = toUIMessageStream({
          stream: result.stream,
          originalMessages: uiMessages,
          generateMessageId: () => crypto.randomUUID(),
          sendReasoning: true,
          sendSources: true,
          /** 元数据随助手消息发送给前端，用于展示时间和模型名称。 */
          messageMetadata: () => ({
            createdAt: assistantCreatedAt,
            modelId: selectedModelId,
          }),
          /** 流正常结束或被用户停止后，把已经生成的助手内容持久化。 */
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
                  citationChunkIds: getKnowledgeCitations(responseMessage).map((citation) => citation.chunkId),
                },
                finishReason: finishReason ?? "other",
                promptTokens: usage?.inputTokens ?? null,
                completionTokens: usage?.outputTokens ?? null,
              })

              /** 会话记录保存最后实际使用的模型，重新进入时可作为默认选项。 */
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

        /** 返回标准 SSE 响应；consumeStream 确保断开连接后仍正确消费流。 */
        return createUIMessageStreamResponse({
          stream: uiMessageStream,
          consumeSseStream: consumeStream,
        })
      } catch (error) {
        throwApiError(error, "Failed to send chat message")
      }
    }
  )
  /** 按置顶状态和更新时间分页获取当前用户的会话列表。 */
  .get(
    "/",
    getAuthUser,
    zValidator("query", chatListQuerySchema),
    async (c) => {
      try {
        const user = c.get("user")
        const { cursor, limit } = c.req.valid("query")
        /** 多取一条用于判断是否还有下一页，而不额外执行 count 查询。 */
        const chats = await prisma.chat.findMany({
          where: { userId: user.id, documentId: null },
          /** 置顶会话优先；同级按最近更新排序，id 用于稳定兜底。 */
          orderBy: [
            { isPinned: "desc" },
            { pinnedAt: "desc" },
            { updatedAt: "desc" },
            { id: "desc" },
          ],
          take: limit + 1,
          /** 游标存在时跳过游标记录，从下一条开始读取。 */
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

        /** 第 limit + 1 条不返回，只用来计算 nextCursor。 */
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
  /** 获取单个会话及其按时间升序排列的全部消息。 */
  .get("/:id", getAuthUser, zValidator("param", chatIdSchema), async (c) => {
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")

      /** userId 放进查询条件，避免用户读取其他账号的会话。 */
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

      /** 拆分会话信息和消息，并把数据库消息映射成前端 UIMessage。 */
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
  /** 修改会话标题或置顶状态，未传入的字段保持不变。 */
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

        /** 使用 updateMany 可以把 id 与 userId 同时作为更新条件。 */
        const result = await prisma.chat.updateMany({
          where: { id, userId: user.id },
          data: {
            ...(title !== undefined ? { title } : {}),
            ...(isPinned !== undefined
              ? {
                isPinned,
                /** 取消置顶时清空时间，重新置顶时记录新的排序时间。 */
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
  /** 删除会话；数据库级联删除消息后，再尽力清理对应 OSS 对象。 */
  .delete("/:id", getAuthUser, zValidator("param", chatIdSchema), async (c) => {
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")
      /** 会话删除后将无法查询附件，因此必须提前收集 OSS Key。 */
      const attachments = await prisma.chatAttachment.findMany({
        where: {
          userId: user.id,
          message: { chatId: id },
        },
        select: { storageKey: true },
      })

      /** id 与 userId 联合限制删除范围，避免越权删除。 */
      const result = await prisma.chat.deleteMany({
        where: { id, userId: user.id },
      })

      if (result.count === 0) {
        throw new HTTPException(404, {
          message: "Chat not found",
        })
      }

      /** OSS 清理失败只记录日志，不回滚已经完成的数据库删除。 */
      await deleteOssObjectsBestEffort(
        attachments.map(({ storageKey }) => storageKey)
      )

      return c.json({ success: true })
    } catch (error) {
      throwApiError(error, "Failed to delete chat")
    }
  })
