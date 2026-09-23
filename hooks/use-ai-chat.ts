"use client"

import { useCallback } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type UIMessage } from "ai"
import { useQueryClient } from "@tanstack/react-query"
import type { ChatModelId } from "@/lib/ai/model"
import { fetchWithAuth } from "@/lib/hono/hono-rpc"

/**
 * API 服务根地址。
 * 删除末尾斜杠，避免拼接 `/api/chat` 时出现双斜杠。
 * 未配置 NEXT_PUBLIC_APP_URL 时使用当前站点的相对地址。
 */
const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? ""

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
        trigger,
      },
    }
  },
})

export interface UseAiChatOptions {
  /** 当前会话 UUID。 */
  chatId: string
  /** 从会话详情接口读取的历史消息。 */
  initialMessages?: UIMessage[]
  /** 当前选择的模型；每次发送时都会读取最新值。 */
  selectedModelId: ChatModelId
  /** 当前选择的工具；工具功能启用前应保持为 null。 */
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
}: UseAiChatOptions) => {
  /** 用于在回复完成后刷新会话列表和会话详情。 */
  const queryClient = useQueryClient()

  /**
   * AI SDK 负责保存前端消息、解析服务端数据流，并维护请求生命周期。
   * initialMessages 只用于 Hook 首次创建时初始化历史记录。
   */
  const chat = useChat({
    id: chatId,
    messages: initialMessages,
    transport: chatTransport,
    /** 降低流式 token 触发的 React 更新频率，长回复时滚动和输入保持流畅。 */
    experimental_throttle: 50,

    /** 助手回复接收完成后，使会话标题、时间和消息缓存重新获取。 */
    onFinish: () => {
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      void queryClient.invalidateQueries({ queryKey: ["chat", chatId] })
    },
  })

  /** submitted 表示等待首个数据块，streaming 表示正在接收内容。 */
  const isGenerating =
    chat.status === "submitted" || chat.status === "streaming"

  /**
   * 发送一条纯文本用户消息。
   *
   * @param text 输入框中的原始文本。
   * @returns 成功发起请求时返回 true；空文本或生成期间返回 false。
   */
  const sendText = useCallback(
    async (text: string) => {
      /** 不把用户误输入的首尾空格写入消息。 */
      const content = text.trim()

      /** 防止发送空消息和流式生成期间重复提交。 */
      if (!content || isGenerating) {
        return false
      }

      /** 新请求开始前清除上一轮错误状态。 */
      chat.clearError()

      /**
       * text 由 AI SDK 转换成 UIMessage text part；模型与工具放在请求
       * options.body 中，由 chatTransport 合并到最终请求体。
       */
      await chat.sendMessage(
        { text: content },
        {
          body: {
            selectedModelId,
            selectedToolName,
          },
        }
      )

      return true
    },
    [chat, isGenerating, selectedModelId, selectedToolName]
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
      await chat.regenerate({
        messageId,
        body: {
          selectedModelId,
          selectedToolName,
        },
      })

      return true
    },
    [chat, isGenerating, selectedModelId, selectedToolName]
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
