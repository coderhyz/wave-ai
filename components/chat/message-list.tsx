"use client"

import { memo } from "react"
import type { ChatStatus, UIMessage } from "ai"
import { Copy, Download, LoaderCircle, RefreshCcw } from "lucide-react"
import { toast } from "sonner"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"

interface ChatMessageProps {
  message: UIMessage
  isGenerating: boolean
  onRegenerate: (messageId: string) => void
}

/** 只在消息内容或流式状态变化时重新渲染单条消息。 */
const ChatMessage = memo(function ChatMessage({
  message,
  isGenerating,
  onRegenerate,
}: ChatMessageProps) {
  const textParts = message.parts.filter(
    (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
      part.type === "text"
  )
  const text = textParts.map((part) => part.text).join("\n")

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("文本已复制")
    } catch {
      toast.error("复制失败")
    }
  }
  // 下载 Markdown 文档
  const downloadMarkdown = () => {
    const roleTitle = message.role === "assistant" ? "AI 回复" : "用户消息"
    const markdown = `# ${roleTitle}\n\n${text.trim()}\n`
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")

    link.href = url
    link.download = `${message.role}-message-${message.id}.md`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success("Markdown 文档已下载")
  }

  return (
    <Message from={message.role}>
      <MessageContent
        className={
          message.role === "user"
            ? "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-primary-foreground shadow-sm md:max-w-[70%]"
            : "w-full"
        }
      >
        {textParts.map((part, index) =>
          message.role === "assistant" ? (
            <MessageResponse key={`${message.id}-${index}`}>
              {part.text}
            </MessageResponse>
          ) : (
            <p
              className="leading-7 break-words whitespace-pre-wrap"
              key={`${message.id}-${index}`}
            >
              {part.text}
            </p>
          )
        )}
      </MessageContent>
      <MessageActions
        className={
          message.role === "user"
            ? "ml-auto text-muted-foreground"
            : "text-muted-foreground"
        }
      >
        <MessageAction disabled={!text} onClick={copyText} tooltip="复制文本">
          <Copy className="size-4" />
        </MessageAction>
        <MessageAction
          disabled={!text}
          onClick={downloadMarkdown}
          tooltip="下载 Markdown"
        >
          <Download className="size-4" />
        </MessageAction>
        {message.role === "user" && (
          <MessageAction
            disabled={isGenerating}
            onClick={() => onRegenerate(message.id)}
            tooltip="重新生成"
          >
            <RefreshCcw className="size-4" />
          </MessageAction>
        )}
      </MessageActions>
    </Message>
  )
})

interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
  error?: Error
  onRetry: () => void
  onRegenerate: (messageId: string) => void
}

/**
 * 消息列表负责长对话滚动、流式内容展示和错误重试。
 * Conversation 会在新 token 到达时保持视图贴近底部，并在用户上滑后显示回到底部按钮。
 */
export function MessageList({
  messages,
  status,
  error,
  onRetry,
  onRegenerate,
}: MessageListProps) {
  const isStreaming = status === "streaming"
  const isWaitingForAssistant =
    status === "submitted" && messages.at(-1)?.role === "user"

  return (
    <Conversation className="min-h-0">
      <ConversationContent className="mx-auto w-full max-w-4xl gap-7 px-4 py-8 md:px-8">
        {messages.map((message) => (
          <ChatMessage
            isGenerating={isStreaming || status === "submitted"}
            key={message.id}
            message={message}
            onRegenerate={onRegenerate}
          />
        ))}

        {isWaitingForAssistant && (
          <Message from="assistant">
            <MessageContent className="flex-row items-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin text-primary" />
              正在思考…
            </MessageContent>
          </Message>
        )}

        {error && (
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <span>{error.message || "消息发送失败，请稍后重试。"}</span>
            <Button
              className="shrink-0"
              onClick={onRetry}
              size="sm"
              type="button"
              variant="destructive"
            >
              <RefreshCcw className="size-4" />
              重试
            </Button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton className="bottom-3 border-primary/20 bg-background/90 text-primary shadow-md" />
    </Conversation>
  )
}
