"use client"

import { useCallback, useLayoutEffect, useState } from "react"
import type { UIMessage } from "ai"
import {
  LoaderCircle,
  MessageCircle,
  Newspaper,
  SquareTerminal,
} from "lucide-react"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { ChatComposer } from "@/components/chat/chat-composer"
import { MessageList } from "@/components/chat/message-list"
import { getMessageWebSearchEnabled } from "@/lib/chat/mapper"
import { useAiChat } from "@/hooks/use-ai-chat"
import { useChatDetail } from "@/hooks/use-chat-list"
import {
  chatModels,
  DEFAULT_MODEL_ID,
  resolveChatModelId,
  type ChatModelId,
} from "@/lib/ai/model"
import { useChatUiStore } from "@/stores/chat-ui-store"
import { toast } from "sonner"

interface ChatShellProps {
  chatId: string
  loadHistory?: boolean
}
// 预制提示词
const presetPrompts = [
  {
    label: "和 DeepSeek 对话",
    prompt: "请介绍一下你能帮我完成哪些事情",
    icon: MessageCircle,
  },
  {
    label: "使用 API 开放平台",
    prompt: "请帮我设计一个接入 AI API 开放平台的实现方案",
    icon: SquareTerminal,
  },
  {
    label: "搜索今日新闻",
    prompt: "请联网搜索今日国内外重要新闻，简要总结，并注明发布时间和来源链接。",
    icon: Newspaper,
  },
] as const

/** 加载已有会话后再创建 useAiChat，保证历史消息只初始化一次。 */
export function ChatShell({ chatId, loadHistory = false }: ChatShellProps) {
  // 显示加载状态，避免在 useAiChat 内部使用 useEffect 触发两次请求
  const { data, isLoading, isError } = useChatDetail(chatId, loadHistory)

  if (loadHistory && isLoading) {
    return (
      <main className="flex h-dvh items-center justify-center bg-gradient-to-b from-primary/10 via-background to-background pt-10">
        <LoaderCircle className="size-7 animate-spin text-primary" />
      </main>
    )
  }

  if (loadHistory && isError) {
    return (
      <main className="flex h-dvh items-center justify-center bg-gradient-to-b from-primary/10 via-background to-background px-4 pt-10 text-sm text-muted-foreground">
        对话记录加载失败，请重新选择会话。
      </main>
    )
  }

  /** 优先使用会话保存的模型；历史值无效时回退到系统默认模型。 */
  const initialModelId =
    chatModels.find((model) => model.id === data?.chat.modelId)?.id ??
    DEFAULT_MODEL_ID

  return (
    <ChatSession
      chatId={chatId}
      documentId={data?.chat.documentId ?? undefined}
      initialModelId={initialModelId}
      initialMessages={data?.messages ?? []}
      key={chatId}
    />
  )
}

interface ChatSessionProps {
  chatId: string
  initialModelId: ChatModelId
  initialMessages: UIMessage[]
  documentId?: string
}

/** 聊天页的交互容器，连接 useAiChat、消息列表和输入区。 */
function ChatSession({
  chatId,
  initialModelId,
  initialMessages,
  documentId,
}: ChatSessionProps) {
  /**
   * 每个 selector 只订阅当前组件需要的字段，避免 Store 中其他会话变化时
   * 让当前聊天页发生无关重渲染。
   */
  const input = useChatUiStore((state) => state.chats[chatId]?.draft ?? "")
  const selectedModelId = useChatUiStore(
    (state) => state.chats[chatId]?.selectedModelId ?? initialModelId
  )
  // 搜索默认可用，菜单开关与模型选择相互独立，并从最后一次发送恢复。
  const [webSearchEnabled, setWebSearchEnabled] = useState(() =>
    getMessageWebSearchEnabled(initialMessages.findLast((message) => message.role === "user"))
  )
  const setDraft = useChatUiStore((state) => state.setDraft)
  const setSelectedModel = useChatUiStore((state) => state.setSelectedModel)



  /** 将输入框变化写入当前 chatId 对应的草稿。 */
  const handleInputChange = useCallback(
    (value: string) => setDraft(chatId, value),
    [chatId, setDraft]
  )
  /** 将模型选择写入当前 chatId，切换会话后可分别恢复。 */
  const handleModelChange = useCallback(
    (modelId: ChatModelId) => setSelectedModel(chatId, modelId),
    [chatId, setSelectedModel]
  )
  // 普通会话默认可联网；文档问答保持固定文档范围。
  const {
    messages,
    status,
    error,
    isUploading,
    sendText,
    regenerate,
    stop,
    clearError,
  } = useAiChat({ chatId, initialMessages, selectedModelId, documentId, webSearchEnabled: !documentId && webSearchEnabled })
  // 发送文本和附件，清除错误状态
  const handleSubmit = useCallback(
    async ({ text, files }: PromptInputMessage) => {
      clearError()
      /** 图片附件需要支持视觉能力的模型。 */
      const hasImageInput = files.some((file) =>
        file.mediaType.startsWith("image/")
      )
      /** 普通文本沿用用户选择；图片输入由模型解析函数决定是否切换。 */
      const effectiveModelId = resolveChatModelId(
        selectedModelId,
        hasImageInput
      )

      if (effectiveModelId !== selectedModelId) {
        setSelectedModel(chatId, effectiveModelId)
        toast.info("图片消息已自动切换到 Qwen 3.7 Flash 视觉模型")
      }

      try {
        return await sendText(text, files, effectiveModelId)
      } catch (submitError) {
        toast.error(
          submitError instanceof Error
            ? submitError.message
            : "消息发送失败，请稍后重试"
        )
        throw submitError
      }
    },
    [chatId, clearError, selectedModelId, sendText, setSelectedModel]
  )

  const handleRetry = useCallback(() => {
    regenerate()
  }, [regenerate])
  // 重新生成
  const handleRegenerate = useCallback(
    (messageId: string) => {
      regenerate(messageId)
    },
    [regenerate]
  )

  /** 空会话展示欢迎页，已有消息时展示消息列表和底部输入框。 */
  const isEmpty = messages.length === 0

  return (
    <main className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-gradient-to-b from-primary/10 via-background to-background pt-10">
      <div className="pointer-events-none absolute inset-x-0 top-10 h-64 bg-[radial-gradient(circle_at_top,var(--primary),transparent_68%)] opacity-[0.07]" />

      {isEmpty ? (
        <section className="relative flex flex-1 flex-col items-center px-4 pt-[clamp(3rem,12vh,8rem)] md:px-8">
          <div className="w-full max-w-5xl">
            <ChatComposer
              webSearchEnabled={webSearchEnabled}
              onWebSearchEnabledChange={documentId ? undefined : setWebSearchEnabled}
              onModelChange={handleModelChange}
              onStop={stop}
              onSubmit={handleSubmit}
              onValueChange={handleInputChange}
              selectedModelId={selectedModelId}
              status={isUploading ? "submitted" : status}
              value={input}
              variant="hero"
            />
            {/* 预制提示词部分 */}
            <Suggestions className="mx-auto mt-8 justify-center px-2 pb-2">
              {presetPrompts.map(({ label, prompt, icon: Icon }) => (
                <Suggestion
                  className="h-11 border-border/80 bg-background/70 px-5 text-sm shadow-xs backdrop-blur-sm hover:border-primary/30 hover:bg-primary/5 hover:text-primary md:text-base"
                  key={label}
                  onClick={handleInputChange}
                  suggestion={prompt}
                >
                  <Icon className="size-4" />
                  {label}
                </Suggestion>
              ))}
            </Suggestions>
          </div>
        </section>
      ) : (
        <section className="relative flex min-h-0 flex-1 flex-col">
          <MessageList
            chatId={chatId}
            error={error}
            messages={messages}
            onRegenerate={handleRegenerate}
            onRetry={handleRetry}
            status={status}
          />

          <div className="border-t border-border/60 bg-background/80 px-4 py-3 backdrop-blur-xl md:px-8 md:py-4">
            <div className="mx-auto w-full max-w-4xl">
              <ChatComposer
              webSearchEnabled={webSearchEnabled}
              onWebSearchEnabledChange={documentId ? undefined : setWebSearchEnabled}
                onModelChange={handleModelChange}
                onStop={stop}
                onSubmit={handleSubmit}
                onValueChange={handleInputChange}
                selectedModelId={selectedModelId}
                status={isUploading ? "submitted" : status}
                value={input}
              />
              <p className="mt-2 text-center text-xs text-muted-foreground">
                AI 生成的内容可能存在错误，请核对重要信息。
              </p>
            </div>
          </div>
        </section>
      )}
    </main>
  )
}
