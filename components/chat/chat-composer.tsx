"use client"

import { useCallback } from "react"
import type { ChatStatus } from "ai"
import { ArrowUp, Globe2, LoaderCircle, Microscope, Square } from "lucide-react"
import { Attachments } from "@/components/ai-elements/attachments"
import { ChatAttachment } from "@/components/chat/attachment-preview"
import { ModelBrandIcon } from "@/components/chat/model-brand-icon"
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import { chatModels, type ChatModelId } from "@/lib/ai/model"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

const ATTACHMENT_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf",
  ".docx",
  ".md",
  ".txt",
  ".json",
  ".csv",
].join(",")

const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024
const MAX_ATTACHMENTS = 3

interface ChatComposerProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (message: PromptInputMessage) => Promise<boolean>
  onStop: () => void
  selectedModelId: ChatModelId
  onModelChange: (modelId: ChatModelId) => void
  status: ChatStatus
  variant?: "hero" | "docked"
  allowAttachments?: boolean
  placeholder?: string
}

/** 在输入框顶部展示待发送附件，删除操作直接更新 PromptInput 的附件状态。 */
function ComposerAttachments() {
  const attachments = usePromptInputAttachments()

  if (attachments.files.length === 0) {
    return null
  }

  return (
    <PromptInputHeader className="px-4 pt-3">
      <Attachments className="w-full" variant="inline">
        {attachments.files.map((file) => (
          <ChatAttachment
            data={file}
            key={file.id}
            onRemove={() => attachments.remove(file.id)}
          />
        ))}
      </Attachments>
    </PromptInputHeader>
  )
}

interface ComposerSubmitButtonProps {
  isHero: boolean
  onStop: () => void
  status: ChatStatus
  value: string
}

/** 附件也可以单独发送，因此按钮状态需要同时读取文本和附件数量。 */
function ComposerSubmitButton({
  isHero,
  onStop,
  status,
  value,
}: ComposerSubmitButtonProps) {
  const attachments = usePromptInputAttachments()
  const isGenerating = status === "submitted" || status === "streaming"

  return (
    <PromptInputSubmit
      className={cn(
        "rounded-full shadow-md shadow-primary/20",
        isHero ? "size-11" : "size-9"
      )}
      disabled={
        !isGenerating && !value.trim() && attachments.files.length === 0
      }
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
  )
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
  allowAttachments = true,
  placeholder = "问点什么，一起探索",
}: ChatComposerProps) {
  const isHero = variant === "hero"
  const isGenerating = status === "submitted" || status === "streaming"
  const selectedModelName =
    chatModels.find((model) => model.id === selectedModelId)?.name ??
    selectedModelId

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const didSend = await onSubmit(message)

      if (didSend) {
        onValueChange("")
      }
    },
    [onSubmit, onValueChange]
  )

  const handleAttachmentError = useCallback(
    ({ code }: { code: "max_files" | "max_file_size" | "accept" }) => {
      if (!allowAttachments) {
        toast.error("文档问答仅支持文字提问")
        return
      }
      const messages = {
        accept: "目前支持图片、PDF、DOCX、TXT、Markdown、JSON 和 CSV 文件",
        max_file_size: "单个附件不能超过 2 MB",
        max_files: "一次最多添加 3 个附件",
      } as const

      toast.error(messages[code])
    },
    [allowAttachments]
  )

  return (
    <PromptInput
      accept={ATTACHMENT_ACCEPT}
      className={cn(
        "[&_[data-slot=input-group]]:bg-background/80 [&_[data-slot=input-group]]:shadow-lg [&_[data-slot=input-group]]:shadow-primary/5 [&_[data-slot=input-group]]:backdrop-blur-xl [&_[data-slot=input-group]]:transition-all [&_[data-slot=input-group]]:focus-within:border-primary/60 [&_[data-slot=input-group]]:focus-within:ring-primary/15",
        isHero
          ? "[&_[data-slot=input-group]]:min-h-42 [&_[data-slot=input-group]]:rounded-[2rem] [&_[data-slot=input-group]]:border-primary/25"
          : "[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border/80"
      )}
      maxFileSize={MAX_ATTACHMENT_SIZE}
      maxFiles={allowAttachments ? MAX_ATTACHMENTS : 0}
      multiple
      onError={handleAttachmentError}
      onSubmit={handleSubmit}
    >
      {allowAttachments && <ComposerAttachments />}

      <PromptInputBody>
        <PromptInputTextarea
          aria-label="输入聊天内容"
          className={cn(
            "px-5 text-base leading-7 placeholder:text-muted-foreground/80",
            isHero ? "min-h-26 pt-5 md:min-h-28 md:px-7 md:pt-6" : "min-h-16"
          )}
          disabled={isGenerating}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          placeholder={placeholder}
          value={value}
        />
      </PromptInputBody>

      <PromptInputFooter
        className={cn("px-4 pb-3", isHero && "px-5 pb-4 md:px-6")}
      >
        <PromptInputTools>
          {allowAttachments && (
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger
                aria-label="添加附件或选择工具"
                className="size-9 rounded-full border border-border/80 bg-background/70 text-foreground shadow-xs hover:border-primary/30 hover:bg-primary/5"
                disabled={isGenerating}
                tooltip="添加附件或工具"
              />
              <PromptInputActionMenuContent
                className="w-60 rounded-2xl border-border/80 p-2 shadow-xl"
                side="top"
              >
                <PromptInputActionAddAttachments
                  className="h-11 rounded-xl text-base"
                  disabled={isGenerating}
                  label="添加照片和文件"
                />
                <PromptInputActionMenuItem
                  className="h-11 rounded-xl text-base"
                  disabled
                >
                  <Microscope className="mr-2 size-5" />
                  深度研究
                </PromptInputActionMenuItem>
                <PromptInputActionMenuItem
                  className="h-11 rounded-xl text-base"
                  disabled
                >
                  <Globe2 className="mr-2 size-5" />
                  网页搜索
                </PromptInputActionMenuItem>
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          )}

          <PromptInputSelect
            disabled={isGenerating}
            onValueChange={(modelId) => onModelChange(modelId as ChatModelId)}
            value={selectedModelId}
          >
            <PromptInputSelectTrigger
              aria-label="选择对话模型"
              className="h-9 rounded-full border border-border/80 bg-background/70 px-4 text-foreground shadow-xs hover:border-primary/30 hover:bg-primary/5"
            >
              <PromptInputSelectValue>
                <ModelBrandIcon modelId={selectedModelId} />
                <span>{selectedModelName}</span>
              </PromptInputSelectValue>
            </PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {chatModels.map((model) => (
                <PromptInputSelectItem key={model.id} value={model.id}>
                  <ModelBrandIcon modelId={model.id} />
                  <span>{model.name}</span>
                </PromptInputSelectItem>
              ))}
            </PromptInputSelectContent>
          </PromptInputSelect>
        </PromptInputTools>

        <ComposerSubmitButton
          isHero={isHero}
          onStop={onStop}
          status={status}
          value={value}
        />
      </PromptInputFooter>
    </PromptInput>
  )
}
