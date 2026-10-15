"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Chat, useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai"
import { useQueryClient } from "@tanstack/react-query"
import type { ChatModelId } from "@/lib/ai/model"
import { fetchWithAuth } from "@/lib/hono/hono-rpc"

/** 未配置时使用同源地址；去掉末尾斜杠，避免拼接出双斜杠。 */
const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? ""

interface UploadedAttachment {
  id: string
  url: string
  filename: string
  mediaType: string
}

/** 先把浏览器中的临时 Data URL 写入 OSS，再把稳定的站内地址交给 AI SDK。 */
const uploadAttachment = async (file: FileUIPart) => {
  const response = await fetchWithAuth(`${appUrl}/api/chat/attachments`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: file.url,
      mediaType: file.mediaType,
      filename: file.filename,
    }),
  })

  const payload = (await response.json().catch(() => null)) as {
    attachment?: UploadedAttachment
    message?: string
  } | null
  if (!response.ok || !payload?.attachment) {
    throw new Error(payload?.message || "附件上传失败，请稍后重试")
  }
  return payload.attachment
}

/** 发送失败时回收尚未被消息认领的附件；已认领附件会由服务端拒绝删除。 */
const deletePendingAttachment = async (id: string) => {
  await fetchWithAuth(`${appUrl}/api/chat/attachments/${id}`, {
    method: "DELETE",
    credentials: "include",
  })
}

/**
 * AI SDK 使用的流式请求 transport。
 *
 * transport 保持为单例，避免组件重新渲染时重建连接配置。
 * 每次请求使用 sendText 或 regenerate 传入的最新模型和工具参数。
 */
const chatTransport = new DefaultChatTransport<UIMessage>({
  /** 服务端流式聊天接口。 */
  api: `${appUrl}/api/chat`,
  /** 跨域请求时也携带 Better Auth 使用的 Cookie。 */
  credentials: "include",
  /** 同时支持 Cookie 和项目中保存的 Bearer Token。 */
  fetch: fetchWithAuth,

  /**
   * 把 AI SDK 默认的 messages 请求转换成服务端 chatSchema 需要的结构。
   * 服务端会从数据库读取完整历史，因此这里只发送最后一条用户消息。
   */
  prepareSendMessagesRequest: ({ id, messages, body, trigger }) => {
    /**
     * 普通发送时最后一条消息就是用户消息；重新生成时 AI SDK 会先
     * 截断旧助手回复，因此反向查找仍能得到需要重新回答的用户消息。
     */
    const message = messages.findLast(({ role }) => role === "user")

    /** 没有用户消息时无法构造有效的模型请求。 */
    if (!message) {
      throw new Error("没有可发送的用户消息")
    }

    // P1 仍消费 SDK 消息流，仅深度研究显式切换到 Agent 入口。
    if (body?.researchMode === "deep-research" && !body?.documentId) {
      if (message.parts.some((part) => part.type !== "text")) {
        throw new Error("深度研究目前仅支持文字提问")
      }
      return {
        api: appUrl + "/api/agent/runs",
        body: {
          id,
          message,
          selectedModelId: body?.selectedModelId,
          trigger,
          mode: "deep-research",
        },
      }
    }

    /**
     * selectedModelId 和 selectedToolName 来自本次 sendText/regenerate，
     * 所以用户切换模型后不需要重新创建 useChat 实例。
     */
    // 发送和重新生成都使用当前工具栏的开关，旧消息的设置不能覆盖用户的新选择。
    const webSearchEnabled = body?.webSearchEnabled ?? true
    return {
      body: {
        id,
        message,
        selectedModelId: body?.selectedModelId,
        selectedToolName: body?.selectedToolName ?? null,
        documentId: body?.documentId,
        webSearchEnabled,
        trigger,
      },
    }
  },
})

/**
 * 保存仍在生成中的 Chat 实例。
 *
 * 普通 useChat 会在组件卸载时调用 stop；把 Chat 作为外部实例传入后，
 * Dashboard 内切换页面只会取消 UI 订阅，不会中断正在消费的响应流。
 */
const backgroundChats = new Map<string, Chat<UIMessage>>()

export interface UseAiChatOptions {
  researchMode?: "chat" | "deep-research"
  /** 网页搜索默认开启；发送和重新生成都读取当前值。 */
  webSearchEnabled?: boolean
  /** 当前会话 UUID。 */
  chatId: string
  /** 从会话详情接口读取的历史消息。 */
  initialMessages?: UIMessage[]
  /** 当前选择的模型；每次发送时都会读取最新值。 */
  selectedModelId: ChatModelId
  /** 文档预览问答的范围；普通聊天省略。 */
  documentId?: string
  /** 额外工具选择；默认知识库检索无需选择。 */
  selectedToolName?: string | null
}

/** 组织发送参数、附件上传与历史刷新；消息和流状态由 AI SDK 管理。 */
export const useAiChat = ({
  chatId,
  initialMessages = [],
  selectedModelId,
  selectedToolName = null,
  documentId,
  webSearchEnabled = true,
  researchMode = "chat",
}: UseAiChatOptions) => {
  /** 用于在回复完成后刷新会话列表和会话详情。 */
  const queryClient = useQueryClient()
  const [isUploading, setIsUploading] = useState(false)

  /**
   * 同一个 chatId 在页面切换前后复用同一实例。
   * 生成完成或失败后移出缓存，下一次进入页面便从数据库读取最终结果。
   */
  const chatInstance = useMemo(() => {
    const existingChat = backgroundChats.get(chatId)
    if (existingChat) {
      return existingChat
    }

    const finishChat = () => {
      queryClient.invalidateQueries({ queryKey: ["chats"] })
      queryClient.invalidateQueries({ queryKey: ["chat", chatId] })
      if (documentId)
        void queryClient.invalidateQueries({
          queryKey: ["document-chat", documentId],
        })
      if (backgroundChats.get(chatId) === instance) {
        backgroundChats.delete(chatId)
      }
    }

    const instance = new Chat<UIMessage>({
      id: chatId,
      messages: initialMessages,
      transport: chatTransport,
      onFinish: finishChat,
      onError: finishChat,
    })

    backgroundChats.set(chatId, instance)
    return instance
  }, [chatId, initialMessages, queryClient, documentId])

  /**
   * 传入外部 Chat 实例后，useChat 只负责订阅状态；组件卸载不会自动 stop。
   */
  const chat = useChat({
    chat: chatInstance,
    /** 降低流式 token 触发的 React 更新频率，长回复时滚动和输入保持流畅。 */
    throttle: 50,
  })

  /** 没有后台任务的实例无需跨页面保留，避免空会话长期占用内存。 */
  useEffect(() => {
    // React Strict Mode 会执行一次额外的挂载/卸载检查，setup 时重新登记可避免开发环境丢失实例。
    backgroundChats.set(chatId, chatInstance)

    return () => {
      const currentChat = backgroundChats.get(chatId)
      const isGenerating =
        currentChat?.status === "submitted" ||
        currentChat?.status === "streaming"

      if (currentChat === chatInstance && !isGenerating) {
        backgroundChats.delete(chatId)
      }
    }
  }, [chatId, chatInstance])

  /** submitted 表示等待首个数据块，streaming 表示正在接收内容。 */
  const isGenerating =
    isUploading || chat.status === "submitted" || chat.status === "streaming"

  /** 附件先上传 OSS；发送失败时回收尚未被消息认领的附件。 */
  const sendText = useCallback(
    async (
      text: string,
      files: FileUIPart[] = [],
      modelId: ChatModelId = selectedModelId
    ) => {
      /** 不把用户误输入的首尾空格写入消息。 */
      const content = text.trim()

      /** 允许单独发送附件，但不允许完全空的消息或并发提交。 */
      if ((!content && files.length === 0) || isGenerating) {
        return false
      }

      if (researchMode === "deep-research" && !documentId && files.length > 0) {
        throw new Error("深度研究目前仅支持文字提问，请移除附件")
      }

      /** 新请求开始前清除上一轮错误状态。 */
      chat.clearError()
      backgroundChats.set(chatId, chatInstance)

      const uploadedIds: string[] = []
      setIsUploading(files.length > 0)

      try {
        const storedFiles: FileUIPart[] = []
        for (const file of files) {
          const attachment = await uploadAttachment(file)
          uploadedIds.push(attachment.id)
          storedFiles.push({
            type: "file",
            url: attachment.url,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
          })
        }

        /**
         * text 由 AI SDK 转换成 UIMessage text part；模型与工具放在请求
         * options.body 中，由 chatTransport 合并到最终请求体。
         */
        await chat.sendMessage(
          {
            text: content,
            files: storedFiles,
            metadata: {
              createdAt: new Date().toISOString(),
              modelId,
              webSearchEnabled,
              mode:
                researchMode === "deep-research" && !documentId
                  ? "deep-research"
                  : "chat",
            },
          },
          {
            body: {
              selectedModelId: modelId,
              selectedToolName,
              documentId,
              webSearchEnabled,
              researchMode,
            },
          }
        )
      } catch (error) {
        await Promise.allSettled(uploadedIds.map(deletePendingAttachment))
        throw error
      } finally {
        setIsUploading(false)
      }

      return true
    },
    [
      chat,
      chatId,
      chatInstance,
      isGenerating,
      selectedModelId,
      selectedToolName,
      documentId,
      webSearchEnabled,
      researchMode,
    ]
  )

  /** 按指定消息重新生成回复；省略 ID 时重试最后一轮。 */
  const regenerate = useCallback(
    async (messageId?: string) => {
      /** 正在生成时不启动第二条并发流。 */
      if (isGenerating) {
        return false
      }

      /** 使用当前模型重新请求，并让服务端通过 trigger 识别重新生成。 */
      chat.clearError()
      backgroundChats.set(chatId, chatInstance)
      await chat.regenerate({
        messageId,
        body: {
          selectedModelId,
          selectedToolName,
          documentId,
          webSearchEnabled,
          researchMode,
        },
      })

      return true
    },
    [
      chat,
      chatId,
      chatInstance,
      isGenerating,
      selectedModelId,
      selectedToolName,
      documentId,
      webSearchEnabled,
      researchMode,
    ]
  )

  /**
   * 向聊天页面暴露渲染所需状态和操作。
   * 输入框文本仍由 ChatComposer 自己管理，避免与 AI SDK 消息状态重复。
   */
  return {
    /** 当前会话 ID。 */
    id: chat.id,
    /** 包含流式增量内容的 UIMessage 列表。 */
    messages: chat.messages,
    /** 手动替换本地消息，通常用于加载或编辑后的状态同步。 */
    setMessages: chat.setMessages,
    /** ready、submitted、streaming 或 error。 */
    status: chat.status,
    /** 最近一次聊天请求错误。 */
    error: chat.error,
    /** 是否正在等待或接收模型回复。 */
    isGenerating,
    /** 是否正在把本地附件写入 OSS。 */
    isUploading,
    sendText,
    regenerate,
    /** 中止当前流式请求，并保留已经收到的内容。 */
    stop: chat.stop,
    /** 清除 AI SDK 保存的错误状态。 */
    clearError: chat.clearError,
  }
}
