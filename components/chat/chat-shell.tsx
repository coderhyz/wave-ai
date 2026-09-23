"use client"

import { useCallback, useState } from "react"
import type { UIMessage } from "ai"
import { LoaderCircle, MessageCircle, SquareTerminal } from "lucide-react"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { ChatComposer } from "@/components/chat/chat-composer"
import { MessageList } from "@/components/chat/message-list"
import { useAiChat } from "@/hooks/use-ai-chat"
import { useChatDetail } from "@/hooks/use-chat-list"
import { DEFAULT_MODEL_ID, type ChatModelId } from "@/lib/ai/model"

interface ChatShellProps {
  chatId: string
  loadHistory?: boolean
}

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

  return (
    <ChatSession
      chatId={chatId}
      initialMessages={data?.messages ?? []}
      key={chatId}
    />
  )
}

interface ChatSessionProps {
  chatId: string
  initialMessages: UIMessage[]
}

/** 聊天页的交互容器，连接 useAiChat、消息列表和输入区。 */
function ChatSession({ chatId, initialMessages }: ChatSessionProps) {
  const [input, setInput] = useState("")
  const [selectedModelId, setSelectedModelId] =
    useState<ChatModelId>(DEFAULT_MODEL_ID)
  const { messages, status, error, sendText, regenerate, stop, clearError } =
    useAiChat({ chatId, initialMessages, selectedModelId })

  const handleSubmit = useCallback(
    async (text: string) => {
      clearError()
      return sendText(text)
    },
    [clearError, sendText]
  )

  const handleRetry = useCallback(() => {
    void regenerate()
  }, [regenerate])

  const handleRegenerate = useCallback(
    (messageId: string) => {
      void regenerate(messageId)
    },
    [regenerate]
  )

  const isEmpty = messages.length === 0

  return (
    <main className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-gradient-to-b from-primary/10 via-background to-background pt-10">
      <div className="pointer-events-none absolute inset-x-0 top-10 h-64 bg-[radial-gradient(circle_at_top,var(--primary),transparent_68%)] opacity-[0.07]" />

      {isEmpty ? (
        <section className="relative flex flex-1 flex-col items-center px-4 pt-[clamp(3rem,12vh,8rem)] md:px-8">
          <div className="w-full max-w-5xl">
            <ChatComposer
              onModelChange={setSelectedModelId}
              onStop={stop}
              onSubmit={handleSubmit}
              onValueChange={setInput}
              selectedModelId={selectedModelId}
              status={status}
              value={input}
              variant="hero"
            />

            <Suggestions className="mx-auto mt-8 justify-center px-2 pb-2">
              {presetPrompts.map(({ label, prompt, icon: Icon }) => (
                <Suggestion
                  className="h-11 border-border/80 bg-background/70 px-5 text-sm shadow-xs backdrop-blur-sm hover:border-primary/30 hover:bg-primary/5 hover:text-primary md:text-base"
                  key={label}
                  onClick={setInput}
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
            error={error}
            messages={messages}
            onRegenerate={handleRegenerate}
            onRetry={handleRetry}
            status={status}
          />

          <div className="border-t border-border/60 bg-background/80 px-4 py-3 backdrop-blur-xl md:px-8 md:py-4">
            <div className="mx-auto w-full max-w-4xl">
              <ChatComposer
                onModelChange={setSelectedModelId}
                onStop={stop}
                onSubmit={handleSubmit}
                onValueChange={setInput}
                selectedModelId={selectedModelId}
                status={status}
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
