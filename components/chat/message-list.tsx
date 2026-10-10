"use client"

import { memo, useLayoutEffect } from "react"
import type { ChatStatus, UIMessage } from "ai"
import { Copy, Download, LoaderCircle, RefreshCcw } from "lucide-react"
import { toast } from "sonner"
import { useStickToBottom } from "use-stick-to-bottom"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Attachments } from "@/components/ai-elements/attachments"
import { ChatAttachment } from "@/components/chat/attachment-preview"
import { ModelBrandIcon } from "@/components/chat/model-brand-icon"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { Button } from "@/components/ui/button"
import { chatModels } from "@/lib/ai/model"

const conversationScrollPositions = new Map<string, number>()

const getConversationScrollStorageKey = (chatId: string) =>
  `wave-ai:conversation-scroll:${chatId}`

const readConversationScrollTop = (chatId: string) => {
  const cachedScrollTop = conversationScrollPositions.get(chatId)
  if (cachedScrollTop !== undefined) return cachedScrollTop

  try {
    const savedValue = sessionStorage.getItem(
      getConversationScrollStorageKey(chatId)
    )
    if (savedValue === null) return null

    const scrollTop = Number(savedValue)
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null

    conversationScrollPositions.set(chatId, scrollTop)
    return scrollTop
  } catch {
    return null
  }
}

const saveConversationScrollTop = (chatId: string, scrollTop: number) => {
  const safeScrollTop = Math.max(0, scrollTop)
  conversationScrollPositions.set(chatId, safeScrollTop)

  try {
    sessionStorage.setItem(
      getConversationScrollStorageKey(chatId),
      String(safeScrollTop)
    )
  } catch {
    // 浏览器禁用存储时，内存缓存仍能覆盖当前页面会话间的切换。
  }
}

interface ChatMessageMetadata {
  createdAt?: string
  modelId?: string | null
}

const getMessageMetadata = (message?: UIMessage): ChatMessageMetadata => {
  const metadata = message?.metadata

  return metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
    ? (metadata as ChatMessageMetadata)
    : {}
}

const formatMessageTime = (value?: string) => {
  if (!value) return "时间未记录"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未记录"

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

interface ChatMessageProps {
  message: UIMessage
  fallbackModelId?: string | null
  isGenerating: boolean
  isLastMessage: boolean
  isStreaming: boolean
  onRegenerate: (messageId: string) => void
}

/** 只在消息内容或流式状态变化时重新渲染单条消息。 */
const ChatMessage = memo(function ChatMessage({
  message,
  fallbackModelId,
  isGenerating,
  isLastMessage,
  isStreaming,
  onRegenerate,
}: ChatMessageProps) {
  const textParts = message.parts.filter(
    (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
      part.type === "text"
  )
  const fileParts = message.parts.filter(
    (part): part is Extract<UIMessage["parts"][number], { type: "file" }> =>
      part.type === "file"
  )
  const imageParts = fileParts.filter((part) =>
    part.mediaType.startsWith("image/")
  )
  const documentParts = fileParts.filter(
    (part) => !part.mediaType.startsWith("image/")
  )
  const reasoningParts = message.parts.filter(
    (
      part
    ): part is Extract<UIMessage["parts"][number], { type: "reasoning" }> =>
      part.type === "reasoning"
  )
  const reasoningText = reasoningParts.map((part) => part.text).join("\n\n")
  const lastPart = message.parts.at(-1)
  const isReasoningStreaming =
    message.role === "assistant" &&
    isLastMessage &&
    isStreaming &&
    (lastPart?.type === "reasoning" ||
      reasoningParts.some((part) => part.state === "streaming"))
  const text = textParts.map((part) => part.text).join("\n")
  const metadata = getMessageMetadata(message)
  const modelId = metadata.modelId ?? fallbackModelId
  const modelName =
    chatModels.find((model) => model.id === modelId)?.name ??
    modelId ??
    "模型未记录"

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
        {message.role === "assistant" && reasoningText && (
          <Reasoning
            className="w-full rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
            isStreaming={isReasoningStreaming}
          >
            <ReasoningTrigger />
            <ReasoningContent className="max-h-80 overflow-y-auto border-t border-border/60 pt-3 leading-6">
              {reasoningText}
            </ReasoningContent>
          </Reasoning>
        )}

        {imageParts.length > 0 && (
          <Attachments
            className={message.role === "user" ? "ml-auto" : "ml-0"}
            variant="grid"
          >
            {imageParts.map((part, index) => (
              <ChatAttachment
                className="border border-border/80 bg-background"
                data={{ ...part, id: `${message.id}-image-${index}` }}
                key={`${message.id}-image-${index}`}
              />
            ))}
          </Attachments>
        )}

        {documentParts.length > 0 && (
          <Attachments className="w-full" variant="list">
            {documentParts.map((part, index) => (
              <ChatAttachment
                className="bg-background/95 text-foreground"
                data={{ ...part, id: `${message.id}-file-${index}` }}
                key={`${message.id}-file-${index}`}
              />
            ))}
          </Attachments>
        )}

        {/* 消息内容 */}
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
        {/* 下载 Markdown 文档 */}
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
      <p
        className={
          message.role === "user"
            ? "ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground/70"
            : "flex items-center gap-1.5 text-[11px] text-muted-foreground/70"
        }
      >
        <ModelBrandIcon modelId={modelId} size={12} />
        <span>
          {modelName} · {formatMessageTime(metadata.createdAt)}
        </span>
      </p>
    </Message>
  )
})

interface MessageListProps {
  chatId: string
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
  chatId,
  messages,
  status,
  error,
  onRetry,
  onRegenerate,
}: MessageListProps) {
  const conversationScroll = useStickToBottom({
    initial: false,
    resize: "smooth",
  })
  const { scrollRef, scrollToBottom } = conversationScroll
  const isStreaming = status === "streaming"
  const isWaitingForAssistant =
    status === "submitted" && messages.at(-1)?.role === "user"

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const savedScrollTop = readConversationScrollTop(chatId)
    if (savedScrollTop === null) {
      void scrollToBottom({ animation: "instant" })
    } else {
      scrollElement.scrollTop = savedScrollTop
    }

    const handleScroll = () => {
      saveConversationScrollTop(chatId, scrollElement.scrollTop)
    }

    scrollElement.addEventListener("scroll", handleScroll, { passive: true })

    return () => {
      saveConversationScrollTop(chatId, scrollElement.scrollTop)
      scrollElement.removeEventListener("scroll", handleScroll)
    }
  }, [chatId, scrollRef, scrollToBottom])

  return (
    <Conversation className="min-h-0" instance={conversationScroll}>
      <ConversationContent className="mx-auto w-full max-w-4xl gap-7 px-4 py-8 md:px-8">
        {messages.map((message, index) => {
          const fallbackModelId =
            message.role === "user"
              ? getMessageMetadata(messages[index + 1]).modelId
              : undefined

          return (
            <ChatMessage
              fallbackModelId={fallbackModelId}
              isGenerating={isStreaming || status === "submitted"}
              isLastMessage={index === messages.length - 1}
              isStreaming={isStreaming}
              key={message.id}
              message={message}
              onRegenerate={onRegenerate}
            />
          )
        })}

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
      {/* 回到底部按钮 */}
      <ConversationScrollButton className="bottom-3 border-primary/20 bg-background/90 text-primary shadow-md" />
    </Conversation>
  )
}
