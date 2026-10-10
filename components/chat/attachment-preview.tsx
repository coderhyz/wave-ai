"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { Eye, FileText, LoaderCircle } from "lucide-react"
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  getAttachmentLabel,
  useAttachmentsContext,
  type AttachmentData,
} from "@/components/ai-elements/attachments"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  getAttachmentPreviewKind,
  getAttachmentPreviewUrl,
  readAttachmentDocument,
  readAttachmentText,
} from "@/lib/chat/attachment-preview"
import { cn } from "@/lib/utils"
import { fetchWithAuth } from "@/lib/hono/hono-rpc"

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; text: string; truncated: boolean }
  | { status: "error"; message: string }

function FilePreviewContent({ data }: { data: AttachmentData }) {
  const url = data.type === "file" ? getAttachmentPreviewUrl(data.url) : null
  const kind =
    data.type === "file" ? getAttachmentPreviewKind(data) : "unsupported"
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" })
  const [imageFailed, setImageFailed] = useState(false)
  const filename = data.type === "file" ? data.filename : undefined
  const mediaType = data.mediaType ?? ""

  // 弹窗关闭时取消读取，重新打开重新挂载，避免旧请求覆盖新附件。
  useEffect(() => {
    if (!url || (kind !== "text" && kind !== "document")) return
    const controller = new AbortController()
    const reading =
      kind === "document"
        ? readAttachmentDocument(
            { url, mediaType, filename },
            controller.signal,
            fetchWithAuth
          )
        : readAttachmentText(url, controller.signal)
    reading.then(
      (result) => {
        if (!controller.signal.aborted)
          setPreview({ status: "ready", ...result })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setPreview({
            status: "error",
            message: error instanceof Error ? error.message : "附件预览失败。",
          })
        }
      }
    )
    return () => controller.abort()
  }, [url, kind, mediaType, filename])

  if (!url) return <p role="alert">附件地址无效或已失效，无法预览。</p>
  if (kind === "image") {
    return imageFailed ? (
      <p role="alert">图片加载失败，附件可能已失效，请重新上传。</p>
    ) : (
      <div className="flex min-h-48 items-center justify-center overflow-auto rounded-xl border bg-muted/30 p-2">
        <Image
          alt={getAttachmentLabel(data)}
          className="h-auto max-h-[65dvh] w-auto max-w-full object-contain"
          height={1200}
          onError={() => setImageFailed(true)}
          src={url}
          unoptimized
          width={1600}
        />
      </div>
    )
  }
  if (kind !== "text" && kind !== "document") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileText className="size-10" />
        <p>暂不支持此格式的在线预览。</p>
        <p className="text-xs">
          当前支持图片、PDF、DOCX、TXT、Markdown、JSON 和 CSV。
        </p>
      </div>
    )
  }
  if (preview.status === "loading") {
    return (
      <div
        className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-4 animate-spin" />
        正在读取附件…
      </div>
    )
  }
  if (preview.status === "error")
    return (
      <p className="text-destructive" role="alert">
        {preview.message}
      </p>
    )
  return (
    <div className="min-h-0 space-y-2">
      {kind === "document" && (
        <p className="text-xs text-muted-foreground">
          以下是模型可读取的文档文字，不包含原始排版和图片；扫描件需先 OCR。
        </p>
      )}
      {/* 按纯文本展示，不执行附件中的 HTML 或脚本。 */}
      <pre className="max-h-[65dvh] overflow-auto rounded-xl border bg-muted/30 p-4 font-mono text-xs leading-6 break-words whitespace-pre-wrap">
        {preview.text || "（空文件）"}
      </pre>
      {preview.truncated && (
        <p className="text-xs text-muted-foreground">
          文件较长，仅预览前 100,000 个字符。
        </p>
      )}
    </div>
  )
}

interface ChatAttachmentProps {
  data: AttachmentData
  className?: string
  onRemove?: () => void
}

/** 复用 AI Elements 附件组合，预览触发器与删除按钮互不嵌套。 */
export function ChatAttachment({
  data,
  className,
  onRemove,
}: ChatAttachmentProps) {
  const { variant } = useAttachmentsContext()
  const label = getAttachmentLabel(data)
  return (
    <Attachment className={className} data={data} onRemove={onRemove}>
      <Dialog>
        <DialogTrigger asChild>
          <button
            aria-label={`预览附件：${label}`}
            className={cn(
              "relative flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              variant === "grid" ? "size-full" : "flex-1 self-stretch"
            )}
            title={`预览 ${label}`}
            type="button"
          >
            <AttachmentPreview />
            <AttachmentInfo showMediaType={variant === "list"} />
            {variant === "grid" ? (
              <span className="absolute inset-x-0 bottom-0 bg-black/55 py-1 text-center text-[10px] text-white opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                点击预览
              </span>
            ) : (
              <Eye className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] gap-4 overflow-y-auto sm:max-w-4xl">
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle className="break-words">{label}</DialogTitle>
            <DialogDescription>
              附件预览 · {data.mediaType || "未知类型"}
            </DialogDescription>
          </DialogHeader>
          <FilePreviewContent
            data={data}
            key={data.type === "file" ? data.url : data.id}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                关闭预览
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AttachmentRemove
        className="opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
        label={`移除 ${label}`}
      />
    </Attachment>
  )
}
