"use client"

import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { ChatModelId } from "@/lib/ai/model"

interface ChatUiEntry {
  /** 当前会话尚未发送的输入内容。 */
  draft?: string
  /** 当前会话最后选择的模型。 */
  selectedModelId?: ChatModelId
  /** 离开当前会话时，消息容器距离顶部的位置。 */
  scrollTop?: number
}

interface ChatUiState {
  /** 以 chatId 为键隔离每个会话的 UI 状态。 */
  chats: Record<string, ChatUiEntry>
  /** 标记 sessionStorage 是否恢复完成，避免提前覆盖持久化数据。 */
  hasHydrated: boolean
  /** 更新指定会话的输入草稿。 */
  setDraft: (chatId: string, draft: string) => void
  /** 更新指定会话选择的模型。 */
  setSelectedModel: (chatId: string, modelId: ChatModelId) => void
  /** 更新指定会话的滚动位置。 */
  setScrollTop: (chatId: string, scrollTop: number) => void
  /** 删除会话时同步删除对应的 UI 状态。 */
  removeChat: (chatId: string) => void
  /** 退出登录时清空所有会话 UI 状态。 */
  clearAll: () => void
  /** 由持久化中间件更新恢复状态。 */
  setHasHydrated: (hasHydrated: boolean) => void
}

/** 只合并一个会话的局部字段，避免覆盖该会话的其他 UI 状态。 */
const updateChat = (
  chats: ChatUiState["chats"],
  chatId: string,
  patch: ChatUiEntry
) => ({
  ...chats,
  [chatId]: { ...chats[chatId], ...patch },
})

/** 只保存跨聊天组件共享的 UI 状态；消息和流式状态仍由 AI SDK 管理。 */
export const useChatUiStore = create<ChatUiState>()(
  persist(
    (set) => ({
      chats: {},
      hasHydrated: false,
      setDraft: (chatId, draft) =>
        set((state) => ({ chats: updateChat(state.chats, chatId, { draft }) })),
      setSelectedModel: (chatId, selectedModelId) =>
        set((state) => ({
          chats: updateChat(state.chats, chatId, { selectedModelId }),
        })),
      setScrollTop: (chatId, scrollTop) =>
        set((state) => ({
          chats: updateChat(state.chats, chatId, {
            scrollTop: Math.max(0, scrollTop),
          }),
        })),
      removeChat: (chatId) =>
        set((state) => {
          const chats = { ...state.chats }
          delete chats[chatId]
          return { chats }
        }),
      clearAll: () => set({ chats: {} }),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    {
      /** sessionStorage 中使用的固定键名。 */
      name: "wave-ai:chat-ui",
      /** UI 状态只需在当前浏览器标签页会话内保留。 */
      storage: createJSONStorage(() => sessionStorage),
      /** hasHydrated 是运行时标记，不需要持久化。 */
      partialize: (state) => ({ chats: state.chats }),
      /** 等客户端挂载后手动恢复，避免服务端渲染阶段访问 sessionStorage。 */
      skipHydration: true,
      /** 数据恢复完成后再允许消息列表读取滚动位置。 */
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    }
  )
)
