"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { UIMessage } from "ai"
import { toast } from "sonner"
import { api } from "@/lib/hono/hono-rpc"
import { useChatUiStore } from "@/stores/chat-ui-store"

export interface ChatListItem {
  id: string
  title: string
  modelId: string | null
  isPinned: boolean
  pinnedAt: string | null
  createdAt: string
  updatedAt: string
  _count: { messages: number }
}

interface ChatListResponse {
  success: true
  items: ChatListItem[]
  nextCursor: string | null
}

export interface ChatDetailResponse {
  success: true
  messages: UIMessage[]
  chat: {
    id: string
    title: string
    modelId: string | null
    documentId: string | null
    isPinned: boolean
    pinnedAt: string | null
    createdAt: string
    updatedAt: string
    userId: string
  }
}

/** 获取侧边栏使用的最近会话列表。 */
export const useChatList = (limit = 50) =>
  useQuery({
    queryKey: ["chats", { limit }],
    queryFn: async () => {
      const response = await api.chat.$get({
        query: { limit: String(limit) },
      })

      if (!response.ok) {
        throw new Error("获取对话列表失败")
      }

      return (await response.json()) as ChatListResponse
    },
  })

/** 读取一个已有会话及其完整消息记录。 */
export const useChatDetail = (chatId: string, enabled = true) =>
  useQuery({
    queryKey: ["chat", chatId],
    queryFn: async () => {
      const response = await api.chat[":id"].$get({
        param: { id: chatId },
      })

      if (!response.ok) {
        throw new Error("获取对话记录失败")
      }

      return (await response.json()) as ChatDetailResponse
    },
    enabled: enabled && Boolean(chatId),
  })

interface UpdateChatVariables {
  id: string
  title?: string
  isPinned?: boolean
}

/** 更新会话标题或置顶状态，并刷新侧边栏中的排序结果。 */
export const useUpdateChat = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, title, isPinned }: UpdateChatVariables) => {
      const response = await api.chat[":id"].$patch({
        param: { id },
        json: {
          ...(title !== undefined ? { title } : {}),
          ...(isPinned !== undefined ? { isPinned } : {}),
        },
      })

      if (!response.ok) {
        throw new Error("更新对话失败")
      }

      return response.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["chats"] })
      queryClient.invalidateQueries({ queryKey: ["chat", variables.id] })
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

/** 删除会话及其消息，并从会话列表缓存中移除对应记录。 */
export const useDeleteChat = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.chat[":id"].$delete({
        param: { id },
      })

      if (!response.ok) {
        throw new Error("删除对话失败")
      }

      return response.json()
    },
    onSuccess: (_, id) => {
      // 后端删除成功后同步清理该会话的草稿、模型选择和滚动位置。
      useChatUiStore.getState().removeChat(id)
      queryClient.removeQueries({ queryKey: ["chat", id] })
      queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}
