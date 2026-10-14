import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import {
  consumeStream, convertToModelMessages, createUIMessageStream,
  createUIMessageStreamResponse, toUIMessageStream, validateUIMessages,
  type UIMessageChunk, type UIMessage,
} from "ai"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { createWebResearchAgent } from "@/lib/agent/agent"
import { sendAgentMessageSchema } from "@/lib/agent/schemas"
import {
  ChatOwnershipError, MessageConflictError, getOrCreateOwnedChat,
  readChatTurn, saveMessageOnce,
} from "@/lib/chat/persistence"
import { deleteOssObjectsBestEffort } from "@/lib/chat-attachment-storage"
import { toUIMessage } from "@/lib/chat/mapper"
import prisma from "@/lib/prisma"

/**
 * 阶段一接口：认证 → 保存问题 → 搜索与总结 → 流式返回 → 保存完整助手消息。
 * 消息继续写入 Chat / Message；这里尚未建立后台任务或 AgentRun 状态管理。
 */
export const agentRoute =
  new Hono()
    .post(
      // 中间件先检查登录身份、请求体大小和参数，再进入执行逻辑。
      "/runs", getAuthUser, bodyLimit({ maxSize: 128 * 1024 }),
      zValidator("json", sendAgentMessageSchema),
      async (c) => {
        try {
          // 1. 身份来自登录 Session，客户端不能指定执行任务的用户。
          const userId = c.get("user").id
          const { id, message: rawMessage, selectedModelId, trigger } = c.req.valid("json")
          // 验证消息格式
          // Zod 校验请求外形，AI SDK 校验消息 parts 的协议语义。
          const [message] = await validateUIMessages<UIMessage>({
            messages: [rawMessage]
          })
          // 服务端记录实际入口，刷新及重新生成时可恢复联网模式。
          message.metadata = {
            createdAt: new Date().toISOString(), modelId: selectedModelId, mode: "web",
          }
          // 省略 documentId 会拒绝已有文档问答会话，保持固定文档范围。
          await getOrCreateOwnedChat({
            id, userId,
            modelId: selectedModelId,
            firstMessage: message
          })
          // 2. 用户消息 ID 是幂等键；相同问题重试不会重复插入用户消息。
          const saved = await saveMessageOnce({
            chatId: id,
            message,
            modelId: selectedModelId,
            metadata: message.metadata,
          })
          // 共用普通聊天的分支规则：重新生成时删除目标问题之后的旧消息。
          const turn = await readChatTurn({
            chatId: id,
            userId,
            messageId: message.id,
            userMessageCreated: saved.created,
            trigger,
          })
          // 数据库分支删除完成后，再清理被删消息关联的 OSS 附件。
          await deleteOssObjectsBestEffort(turn.attachmentKeys)
          // 历史消息供 SDK 组织本次响应；下面实际送给研究模型的只有当前文字问题。
          const originalMessages = turn.messages.map(toUIMessage)
          const { agent, sources } = createWebResearchAgent(selectedModelId)
          // 单次联网只处理当前文字问题，不把历史附件或私有检索结果送入搜索链。
          // agent执行
          const result = await agent.stream({
            messages: await convertToModelMessages([message]),
            abortSignal: c.req.raw.signal,
          })
          // 3. 使用同一创建时间生成流式元数据和最终入库记录。
          const createdAt = new Date().toISOString()
          // 记录已发送的来源数量，多个工具结果事件不会重复插入来源。
          let sourceCount = 0
          // 外层 SDK 流收集完整助手消息，包括下面补入的 source-url parts。
          const stream = createUIMessageStream({
            originalMessages,
            generateId: () => crypto.randomUUID(),
            execute: ({ writer }) => {
              // 内层转换模型文本和工具事件；来源由真实搜索结果显式补入。
              writer.merge(toUIMessageStream({
                stream: result.stream, sendReasoning: false, sendSources: false,
                messageMetadata: () => ({ createdAt, modelId: selectedModelId, mode: "web" }),
              }).pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
                transform(chunk, controller) {
                  controller.enqueue(chunk)
                  // 工具完成后 sources 已填充，将链接送给前端并纳入同一条助手消息。
                  if (chunk.type === "tool-output-available") {
                    for (const source of sources.slice(sourceCount)) controller.enqueue(source)
                    sourceCount = sources.length
                  }
                },
              })))
            },
            // 4. 流结束后保存完整 parts，刷新时可重建文本、工具状态和来源。
            onEnd: async ({ responseMessage, isAborted, finishReason }) => {
              // totalUsage 汇总两个模型步骤；停止时用量可能拿不到，仍保存已有部分消息。
              const [usage] = await Promise.allSettled([result.totalUsage])
              if (!isAborted && usage.status === "rejected") throw usage.reason
              await saveMessageOnce({
                chatId: id,
                message: responseMessage,
                modelId: selectedModelId,
                metadata: { createdAt, modelId: selectedModelId, mode: "web", isAborted },
                finishReason: finishReason ?? "other",
                promptTokens: usage.status === "fulfilled" ? usage.value.inputTokens : null,
                completionTokens: usage.status === "fulfilled" ? usage.value.outputTokens : null,
              })
              // 历史会话记录本次实际模型，重新打开时用于初始化模型选择。
              await prisma.chat.updateMany({ where: { id, userId }, data: { modelId: selectedModelId } })
            },
            onError: (error) => {
              console.error("Web research stream failed", error)
              return "联网回复生成或保存失败，请稍后重试。"
            },
          })
          // SDK 输出标准 SSE；独立消费流，以便客户端断开后仍执行结束和保存回调。
          return createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream })
        } catch (error) {
          // 所有权失败返回 404，避免泄露其他用户的会话；消息冲突返回 409。
          if (error instanceof ChatOwnershipError) throw new HTTPException(404, { message: "Chat not found" })
          if (error instanceof MessageConflictError) throw new HTTPException(409, { message: error.message })
          throw error
        }
      }
    )
