"use client"

import { useCallback } from "react"
import type { ChatStatus } from "ai"
import {
  ArrowUp,
  BrainCircuit,
  LoaderCircle,
  Search,
  Square,
} from "lucide-react"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { chatModels, type ChatModelId } from "@/lib/ai/model"
import { cn } from "@/lib/utils"

interface ChatComposerProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => Promise<boolean>
  onStop: () => void
  selectedModelId: ChatModelId
  onModelChange: (modelId: ChatModelId) => void
  status: ChatStatus
  variant?: "hero" | "docked"
}

/**
 * 聊天输入区。
 *
 * hero 用于空会话的大输入框，docked 用于消息列表底部。两种形态共用同一套
 * 提交、停止生成和模型选择逻辑，避免页面切换状态时出现行为差异。
 */
export function ChatComposer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  selectedModelId,
  onModelChange,
  status,
  variant = "docked",
}: ChatComposerProps) {
  const isHero = variant === "hero"
  const isGenerating = status === "submitted" || status === "streaming"

  const handleSubmit = useCallback(
    async ({ text }: PromptInputMessage) => {
      const didSend = await onSubmit(text)

      if (didSend) {
        onValueChange("")
      }
    },
    [onSubmit, onValueChange]
  )

  return (
    <PromptInput
      className={cn(
        "[&_[data-slot=input-group]]:bg-background/80 [&_[data-slot=input-group]]:shadow-lg [&_[data-slot=input-group]]:shadow-primary/5 [&_[data-slot=input-group]]:backdrop-blur-xl [&_[data-slot=input-group]]:transition-all [&_[data-slot=input-group]]:focus-within:border-primary/60 [&_[data-slot=input-group]]:focus-within:ring-primary/15",
        isHero
          ? "[&_[data-slot=input-group]]:min-h-42 [&_[data-slot=input-group]]:rounded-[2rem] [&_[data-slot=input-group]]:border-primary/25"
          : "[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border/80"
      )}
      onSubmit={handleSubmit}
    >
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="输入聊天内容"
          className={cn(
            "px-5 text-base leading-7 placeholder:text-muted-foreground/80",
            isHero ? "min-h-26 pt-5 md:min-h-28 md:px-7 md:pt-6" : "min-h-16"
          )}
          disabled={isGenerating}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          placeholder="问点什么，一起探索"
          value={value}
        />
      </PromptInputBody>

      <PromptInputFooter
        className={cn("px-4 pb-3", isHero && "px-5 pb-4 md:px-6")}
      >
        <PromptInputTools>
          <PromptInputSelect
            disabled={isGenerating}
            onValueChange={(modelId) => onModelChange(modelId as ChatModelId)}
            value={selectedModelId}
          >
            <PromptInputSelectTrigger
              aria-label="选择对话模型"
              className="h-9 rounded-full border border-border/80 bg-background/70 px-4 text-foreground shadow-xs hover:border-primary/30 hover:bg-primary/5"
            >
              <BrainCircuit className="size-4 text-primary" />
              <PromptInputSelectValue />
            </PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {chatModels.map((model) => (
                <PromptInputSelectItem key={model.id} value={model.id}>
                  {model.name}
                </PromptInputSelectItem>
              ))}
            </PromptInputSelectContent>
          </PromptInputSelect>

          <PromptInputButton
            aria-label="智能搜索功能即将开放"
            className="h-9 rounded-full border border-border/80 bg-background/70 px-4 text-muted-foreground shadow-xs"
            disabled
          >
            <Search className="size-4" />
            智能搜索
          </PromptInputButton>
        </PromptInputTools>

        <PromptInputSubmit
          className={cn(
            "rounded-full shadow-md shadow-primary/20",
            isHero ? "size-11" : "size-9"
          )}
          disabled={!value.trim() && !isGenerating}
          onStop={onStop}
          status={status}
        >
          {status === "submitted" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : status === "streaming" ? (
            <Square className="size-3.5 fill-current" />
          ) : (
            <ArrowUp className="size-5" />
          )}
        </PromptInputSubmit>
      </PromptInputFooter>
    </PromptInput>
  )
}
