"use client"

import { memo, useCallback, useLayoutEffect, useRef } from "react"
import type { ChatStatus, UIMessage } from "ai"
import { useVirtualizer } from "@tanstack/react-virtual"
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
import { useChatUiStore } from "@/stores/chat-ui-store"

/** 短列表直接渲染更简单；达到该数量后才启用虚拟列表。 */
const VIRTUALIZATION_THRESHOLD = 50
/** 可视区域上下各多渲染的消息数量，用少量 DOM 换取连续滚动体验。 */
const MESSAGE_OVERSCAN = 4

/** 在真实 DOM 高度测量完成前，为不同内容提供较接近的初始高度。 */
const estimateMessageHeight = (message?: UIMessage) => {
  if (!message) return 160

  /** 文本长度用于粗略估算尚未挂载到 DOM 的消息高度。 */
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  /** 限制文本预估的最大增量，避免超长消息制造过大的初始占位。 */
  const textHeight = Math.min(600, Math.ceil(text.length / 120) * 28)
  /** reasoning、附件和代码块通常比纯文本高，分别增加经验高度。 */
  const reasoningHeight = message.parts.some(
    (part) => part.type === "reasoning"
  )
    ? 180
    : 0
  const attachmentHeight = message.parts.some((part) => part.type === "file")
    ? 160
    : 0
  const codeHeight = text.includes("```") ? 180 : 0
  /** 助手消息包含操作栏和模型信息，因此基础高度略大。 */
  const baseHeight = message.role === "user" ? 96 : 150

  return baseHeight + textHeight + reasoningHeight + attachmentHeight + codeHeight
}

interface ChatMessageMetadata {
  createdAt?: string
  modelId?: string | null
}

/**
 * UIMessage.metadata 的公开类型是 unknown，这里先做运行时外形检查，
 * 避免历史脏数据或不同版本消息导致属性读取报错。
 */
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

/**
 * 单条消息组件。
 *
 * 外层 MessageList 在每个流式 token 到达时都会重新执行 messages.map，
 * memo 可以让没有变化的历史消息跳过 Markdown 和附件的重复渲染，通常只有
 * 最后一条助手消息会持续更新。
 */
const ChatMessage = memo(function ChatMessage({
  message,
  fallbackModelId,
  isGenerating,
  isLastMessage,
  isStreaming,
  onRegenerate,
}: ChatMessageProps) {
  /**
   * AI SDK 把一条消息表示成多个 part。先按类型拆开，后续区域就只处理
   * 自己关心的数据，也能借助 TypeScript 类型守卫获得准确的字段类型。
   */
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

  /** 同一消息可能产生多个 reasoning part，展示时按产生顺序合并。 */
  const reasoningText = reasoningParts.map((part) => part.text).join("\n\n")
  const lastPart = message.parts.at(-1)

  /**
   * 只有“最后一条、仍在流式生成、当前仍输出 reasoning”的助手消息，
   * 才让思考组件保持流式状态；历史思考内容不应重新出现动画。
   */
  const isReasoningStreaming =
    message.role === "assistant" &&
    isLastMessage &&
    isStreaming &&
    (lastPart?.type === "reasoning" ||
      reasoningParts.some((part) => part.state === "streaming"))
  const text = textParts.map((part) => part.text).join("\n")
  const metadata = getMessageMetadata(message)

  /**
   * 新消息直接记录 modelId；部分旧用户消息没有记录模型时，使用紧随其后的
   * 助手消息模型作为展示兜底，不会修改消息本身。
   */
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
  /** 只导出文本 part；附件和 reasoning 不写入 Markdown 文件。 */
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
        {/* 助手 reasoning 独立于最终正文，可折叠并拥有自己的滚动区域。 */}
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

        {/* 图片使用网格预览；原文件地址仍由 ChatAttachment 统一处理。 */}
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

        {/* 非图片附件使用文件列表，避免文档占用大面积消息空间。 */}
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

        {/*
         * 助手正文交给 Streamdown 渲染 Markdown；用户正文按纯文本展示，
         * 避免用户输入被解释成复杂 Markdown，同时保留换行。
         */}
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
        {/* 重新生成以用户消息为锚点，因此只显示在用户消息操作栏。 */}
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
  /**
   * useStickToBottom 管理“用户位于底部时跟随新 token、用户上滑后暂停跟随”。
   * initial:false 避免 Hook 抢先滚动，首次位置由下面的恢复逻辑决定。
   */
  const conversationScroll = useStickToBottom({
    initial: false,
    resize: "smooth",
  })
  const { scrollRef, scrollToBottom } = conversationScroll
  /** 持久化数据恢复完成前不读取滚动位置。 */
  const hasHydrated = useChatUiStore((state) => state.hasHydrated)
  /** 保存滚动位置的节流定时器，避免每次 scroll 事件都写 Store。 */
  const scrollSaveTimer = useRef<number | null>(null)

  /** 短对话保留普通渲染，只有长对话才承担虚拟化复杂度。 */
  const shouldVirtualize = messages.length >= VIRTUALIZATION_THRESHOLD
  /** 使用消息 id 作为稳定键，避免增删消息后复用错误的 DOM。 */
  const getItemKey = useCallback(
    (index: number) => messages[index]?.id ?? index,
    [messages]
  )
  /** DOM 未挂载时先使用预估高度，挂载后会被真实测量值替换。 */
  const estimateSize = useCallback(
    (index: number) => estimateMessageHeight(messages[index]),
    [messages]
  )
  // TanStack Virtual 会自行管理可变 DOM 测量，React Compiler 不应尝试缓存它。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    /** 虚拟项数量始终与消息数量一致。 */
    count: messages.length,
    /** 未达到阈值时关闭虚拟计算。 */
    enabled: shouldVirtualize,
    estimateSize,
    getItemKey,
    /** Conversation 的滚动容器是虚拟列表的观察目标。 */
    getScrollElement: () => scrollRef.current,
    overscan: MESSAGE_OVERSCAN,
    /** 与普通列表的上下内边距保持一致。 */
    paddingEnd: 32,
    paddingStart: 32,
  })
  /** 仅流式生成阶段持续更新最后一条助手消息。 */
  const isStreaming = status === "streaming"

  /** 请求已经提交但助手消息尚未出现时，显示单独的等待占位。 */
  const isWaitingForAssistant =
    status === "submitted" && messages.at(-1)?.role === "user"

  useLayoutEffect(() => {
    if (!hasHydrated) return

    /** scrollRef 指向 Conversation 内部真正发生滚动的元素。 */
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    /**
     * useLayoutEffect 在浏览器绘制前恢复位置，减少用户看到“先在顶部、再跳动”的闪烁。
     * 从未访问过的会话直接定位到底部；访问过的会话恢复离开时的位置。
     */
    /** 直接读取快照，不订阅 chats，滚动写入不会导致列表重渲染。 */
    const savedScrollTop =
      useChatUiStore.getState().chats[chatId]?.scrollTop
    if (savedScrollTop === undefined) {
      void scrollToBottom({ animation: "instant" })
    } else {
      scrollElement.scrollTop = savedScrollTop
    }

    /** 节流保存，避免滚动事件连续序列化整个 Store。 */
    const handleScroll = () => {
      if (scrollSaveTimer.current !== null) return
      scrollSaveTimer.current = window.setTimeout(() => {
        scrollSaveTimer.current = null
        useChatUiStore
          .getState()
          .setScrollTop(chatId, scrollElement.scrollTop)
      }, 150)
    }

    scrollElement.addEventListener("scroll", handleScroll, { passive: true })

    /** 切换会话或卸载前再保存一次，覆盖最后一次尚未触发监听的布局变化。 */
    return () => {
      if (scrollSaveTimer.current !== null) {
        window.clearTimeout(scrollSaveTimer.current)
        scrollSaveTimer.current = null
      }
      useChatUiStore.getState().setScrollTop(chatId, scrollElement.scrollTop)
      scrollElement.removeEventListener("scroll", handleScroll)
    }
  }, [chatId, hasHydrated, scrollRef, scrollToBottom])

  /** 普通列表和虚拟列表共用同一套单条消息渲染逻辑。 */
  const renderMessage = (index: number) => {
    const message = messages[index]
    if (!message) return null

    /**
     * 旧用户消息可能没有 modelId：读取下一条助手消息，仅用于底部模型标签。
     * 正常情况下用户消息后面就是对应的助手回复。
     */
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
  }

  return (
    <Conversation className="min-h-0" instance={conversationScroll}>
      <ConversationContent
        className={
          shouldVirtualize
            ? "block p-0"
            : "mx-auto w-full max-w-4xl gap-7 px-4 py-8 md:px-8"
        }
      >
        {/* 长列表只挂载可视区域；短列表仍直接渲染全部消息。 */}
        {shouldVirtualize ? (
          // 总高度负责撑开滚动区域，未渲染的消息无需保留 DOM。
          <div
            className="relative mx-auto w-full max-w-4xl"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {/* data-index 和 ref 用于把每条消息的真实高度回写给虚拟列表。 */}
            {virtualizer.getVirtualItems().map((virtualItem) => (
              <div
                className="absolute top-0 left-0 w-full px-4 pb-7 md:px-8"
                data-index={virtualItem.index}
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                style={{
                  // 所有虚拟项从容器顶部定位，再移动到计算后的实际位置。
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {renderMessage(virtualItem.index)}
              </div>
            ))}
          </div>
        ) : (
          messages.map((_message, index) => renderMessage(index))
        )}

        {(isWaitingForAssistant || error) && (
          <div
            className={
              shouldVirtualize
                ? "mx-auto flex w-full max-w-4xl flex-col gap-7 px-4 pb-8 md:px-8"
                : "contents"
            }
          >
            {/* 首个流式消息块到达后，真实助手消息会替换这个等待占位。 */}
            {isWaitingForAssistant && (
              <Message from="assistant">
                <MessageContent className="flex-row items-center gap-2 text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin text-primary" />
                  正在思考…
                </MessageContent>
              </Message>
            )}

            {/* 错误保留在消息列表底部，重试会复用 useAiChat 的 regenerate 流程。 */}
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
          </div>
        )}
      </ConversationContent>
      {/* 用户主动上滑离开底部后，Conversation 才会显示这个快捷按钮。 */}
      <ConversationScrollButton className="bottom-3 border-primary/20 bg-background/90 text-primary shadow-md" />
    </Conversation>
  )
}
