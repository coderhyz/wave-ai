"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Chat, useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai"
import { useQueryClient } from "@tanstack/react-query"
import type { ChatModelId } from "@/lib/ai/model"
import { fetchWithAuth } from "@/lib/hono/hono-rpc"

/**
 * API 服务根地址。
 * 删除末尾斜杠，避免拼接 `/api/chat` 时出现双斜杠。
 * 未配置 NEXT_PUBLIC_APP_URL 时使用当前站点的相对地址。
 */
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

    /**
     * selectedModelId 和 selectedToolName 来自本次 sendText/regenerate，
     * 所以用户切换模型后不需要重新创建 useChat 实例。
     */
    return {
      body: {
        id,
        message,
        selectedModelId: body?.selectedModelId,
        selectedToolName: body?.selectedToolName ?? null,
        documentId: body?.documentId,
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

/**
 * 封装 AI SDK useChat，负责前端与 POST /api/chat 的流式交互。
 *
 * 消息和流状态由 AI SDK 管理；该 Hook 只负责组织服务端请求参数、
 * 提供文本发送与重新生成方法，并在回复完成后刷新会话缓存。
 *
 * @param chatId 当前会话 UUID。
 * @param initialMessages 服务端读取的历史消息。
 * @param selectedModelId 当前选择的模型 ID。
 * @param selectedToolName 当前选择的工具名称。
 * @returns 消息、流状态以及发送、停止、重新生成等操作方法。
 */
export const useAiChat = ({
  chatId,
  initialMessages = [],
  selectedModelId,
  selectedToolName = null,
  documentId,
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

    const refreshQueries = () => {
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      void queryClient.invalidateQueries({ queryKey: ["chat", chatId] })
      if (documentId)
        void queryClient.invalidateQueries({
          queryKey: ["document-chat", documentId],
        })
    }

    const instance = new Chat<UIMessage>({
      id: chatId,
      messages: initialMessages,
      transport: chatTransport,
      onFinish: () => {
        refreshQueries()
        if (backgroundChats.get(chatId) === instance) {
          backgroundChats.delete(chatId)
        }
      },
      onError: () => {
        refreshQueries()
        if (backgroundChats.get(chatId) === instance) {
          backgroundChats.delete(chatId)
        }
      },
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

  /**
   * 发送一条用户消息，文本和附件都会成为同一条 UIMessage 的 parts。
   *
   * @param text 输入框中的原始文本。
   * @param files 浏览器中已转换为 Data URL 的临时附件；发送前会先写入 OSS。
   * @returns 成功发起请求时返回 true；空消息或生成期间返回 false。
   */
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
            },
          },
          {
            body: {
              selectedModelId: modelId,
              selectedToolName,
              documentId,
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
    ]
  )

  /**
   * 重新生成一条助手回复。
   *
   * @param messageId 需要重新生成的助手消息 ID；不传时使用最后一条。
   * @returns 成功发起请求时返回 true；生成期间返回 false。
   */
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
    /** 输入框当前是否允许提交。 */
    canSubmit: !isGenerating,
    sendText,
    regenerate,
    /** 中止当前流式请求，并保留已经收到的内容。 */
    stop: chat.stop,
    /** 清除 AI SDK 保存的错误状态。 */
    clearError: chat.clearError,
  }
}
