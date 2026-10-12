"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  Copy,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { Streamdown, type UrlTransform } from "streamdown"
import {
  KnowledgeRequestError,
  useKnowledgeDocument,
  useSaveKnowledgeDocumentContent,
  useReparseKnowledgeDocument,
  useDeleteKnowledgeDocument,
  downloadKnowledgeDocumentOriginal,
  type KnowledgeDocument,
} from "@/hooks/use-knowledge"
import type { SaveKnowledgeDocumentContentInput } from "@/lib/knowledge/schemas"
import { MAX_MARKDOWN_CHARACTERS } from "@/lib/knowledge/parsers/types"
import {
  getKnowledgeAssetUrl,
  isSafeKnowledgeAssetName,
} from "@/lib/knowledge/assets"
import { useStreamdownPlugins } from "@/components/ai-elements/use-streamdown-plugins"
import { MessageCodeBlock } from "@/components/ai-elements/code-block-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { documentStatusLabels } from "./knowledge-tree"
import { FilePreview } from "./file-preview"

/** 原始 HTML 不执行，图片仅允许当前文档的鉴权资源，防止外部追踪图片。 */
export function KnowledgeMarkdown({
  content,
  documentId,
}: {
  content: string
  documentId: string
}) {
  const plugins = useStreamdownPlugins(content)
  const urlTransform: UrlTransform = (url, key) => {
    if (key === "src") {
      const prefix = getKnowledgeAssetUrl(documentId, "")
      return url.startsWith(prefix) &&
        isSafeKnowledgeAssetName(url.slice(prefix.length))
        ? url
        : ""
    }
    return /^(https?:\/\/|mailto:|#)/i.test(url) ? url : ""
  }
  return (
    <Streamdown
      mode="static"
      plugins={plugins}
      skipHtml
      rehypePlugins={[]}
      urlTransform={urlTransform}
      controls={{ image: false }}
      components={{
        // 复用代码复制/下载控件，图表代码也只展示源码，不生成可加载外部资源的 SVG。
        code: MessageCodeBlock,
        a: ({ href, children }) =>
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        img: ({ src, alt }) =>
          typeof src === "string" && src ? (
            // 站内鉴权图片不能交给 Next Image 的服务端代理，否则会丢失用户 Cookie。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={alt ?? "解析图片"}
              loading="lazy"
              className="max-w-full rounded-md"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              [图片未加载{alt ? `：${alt}` : ""}]
            </span>
          ),
      }}
      className="min-w-0 break-words"
    >
      {content}
    </Streamdown>
  )
}

/** MD 沿用正文编辑器，其他文件直接预览 OSS 原件，不等待解析完成。 */
export function DocumentPreview({
  documentId,
  onLeaveGuardChange,
  onDeleted,
  onPreviewOriginal,
}: {
  documentId: string
  onLeaveGuardChange?: (guard: () => boolean) => void
  onDeleted?: () => void
  onPreviewOriginal?: () => void
}) {
  const query = useKnowledgeDocument(documentId)
  const reparse = useReparseKnowledgeDocument(documentId)
  const deletion = useDeleteKnowledgeDocument(documentId)
  const download = useMutation({
    mutationFn: (filename: string) =>
      downloadKnowledgeDocumentOriginal(documentId, filename),
    retry: false,
  })
  const [confirmation, setConfirmation] = useState<{
    action: "reparse" | "delete"
    contentRevision: number
  } | null>(null)
  const leaveGuard = useRef<() => boolean>(() => true)
  const registerLeaveGuard = useCallback(
    (guard: () => boolean) => {
      leaveGuard.current = guard
      onLeaveGuardChange?.(guard)
    },
    [onLeaveGuardChange]
  )
  const changingDocument = reparse.isPending || deletion.isPending
  const actionError =
    confirmation?.action === "reparse" ? reparse.error : deletion.error
  if (!documentId)
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileText className="size-10" />
        <p>选择一份文档进行预览</p>
        <p className="text-sm">支持 PDF、DOCX、TXT、MD</p>
      </div>
    )
  if (query.isPending)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        正在读取文档…
      </p>
    )
  if (query.isError && !query.data)
    return (
      <div role="alert" className="space-y-3 p-8">
        <p className="text-sm text-destructive">{query.error.message}</p>
        <Button variant="outline" onClick={() => query.refetch()}>
          重新读取
        </Button>
      </div>
    )
  const document = query.data.document
  const showOriginal = document.type !== "MARKDOWN"
  const processing =
    document.status === "QUEUED" || document.status === "PARSING"
  return (
    <article className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 text-lg font-semibold break-words">
            {document.title}
          </h2>
          <Badge
            variant={document.status === "FAILED" ? "destructive" : "secondary"}
          >
            {documentStatusLabels[document.status]}
          </Badge>
          <Badge variant="outline">{document.type}</Badge>
          {!showOriginal && onPreviewOriginal && document.originalFileName && (
            <Button variant="outline" size="sm" onClick={onPreviewOriginal}>
              <Eye />
              原件预览
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="文档操作"
                className="ml-auto"
                disabled={changingDocument || download.isPending}
              >
                {changingDocument || download.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <MoreHorizontal />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                disabled={!document.originalFileName}
                onSelect={() =>
                  download.mutate(document.originalFileName ?? "", {
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                <Download />
                下载原件
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={processing || !document.originalFileName}
                onSelect={() => {
                  reparse.reset()
                  setConfirmation({
                    action: "reparse",
                    contentRevision: document.contentRevision,
                  })
                }}
              >
                <RefreshCw />
                重新解析
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  deletion.reset()
                  setConfirmation({
                    action: "delete",
                    contentRevision: document.contentRevision,
                  })
                }}
              >
                <Trash2 />
                删除文档
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="text-xs break-words text-muted-foreground">
          {document.originalFileName}
          {!showOriginal &&
            ` · Markdown 文档 · 正文版本 ${document.contentRevision}`}
        </p>
        {/* 后台读取失败时保留编辑器与草稿，但仍明确显示错误。 */}
        {query.isError && (
          <p role="alert" className="text-sm text-destructive">
            读取最新正文失败：{query.error.message}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-5 md:p-8">
        {/* PDF / DOCX / TXT 不挂载 Markdown 编辑器，避免把解析正文当作文件预览。 */}
        {showOriginal && (
          <FilePreview documentId={documentId} showFileInfo={false} />
        )}
        {!showOriginal && processing && (
          <div
            role="status"
            className="flex items-center gap-3 rounded-lg border bg-muted/30 p-5 text-sm"
          >
            <LoaderCircle className="size-5 shrink-0 animate-spin" />
            <div>
              <p>
                {document.status === "QUEUED"
                  ? "等待解析任务执行"
                  : "正在转换为 Markdown"}
              </p>
              <p className="mt-1 text-muted-foreground">
                完成后会自动显示正文，请确保文档 Worker 已启动。
              </p>
            </div>
          </div>
        )}
        {!showOriginal && document.status === "FAILED" && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-destructive/30 p-5 text-sm text-destructive"
          >
            <p>文档解析失败</p>
            <p>{document.parseErrorMessage}</p>
            {document.parseErrorCode && (
              <p className="text-xs">{document.parseErrorCode}</p>
            )}
          </div>
        )}
        {!showOriginal && document.status === "READY" && (
          <DocumentEditor
            key={document.id}
            document={document}
            reloading={query.isFetching || changingDocument}
            onLeaveGuardChange={registerLeaveGuard}
            onReload={async () => {
              const result = await query.refetch()
              if (result.error) throw result.error
            }}
          />
        )}
      </div>
      {/* 同一确认框承载两项破坏性操作；失败不关闭，也不丢弃编辑器草稿。 */}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !changingDocument) setConfirmation(null)
        }}
      >
        <DialogContent showCloseButton={!changingDocument}>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === "reparse"
                ? "重新解析文档？"
                : "删除文档？"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "reparse"
                ? `将从原件重新解析「${document.title}」。成功后替换当前正文（版本 ${confirmation.contentRevision}），已保存的编辑不会保留；失败不会清除现有正文。此操作不可撤销。`
                : `将删除「${document.title}」，取消解析任务，并由 Worker 清理原件和解析图片。此操作不可撤销。`}
            </DialogDescription>
          </DialogHeader>
          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError.message}
              {actionError instanceof KnowledgeRequestError &&
                actionError.status === 409 &&
                " 请关闭对话框并重新读取最新文档后再操作。"}
            </p>
          )}
          <DialogFooter>
            {actionError instanceof KnowledgeRequestError &&
              actionError.status === 409 && (
                <Button
                  variant="outline"
                  disabled={changingDocument || query.isFetching}
                  onClick={async () => {
                    const result = await query.refetch()
                    if (!result.error) setConfirmation(null)
                  }}
                >
                  重新读取文档
                </Button>
              )}
            <Button
              variant="outline"
              disabled={changingDocument}
              onClick={() => setConfirmation(null)}
            >
              取消
            </Button>
            <Button
              variant={
                confirmation?.action === "delete" ? "destructive" : "default"
              }
              disabled={
                changingDocument ||
                (confirmation?.action === "reparse" && processing)
              }
              onClick={() => {
                // 未保存草稿再由编辑器确认；保存请求尚未完成时不允许破坏性操作。
                if (!confirmation || !leaveGuard.current()) return
                if (confirmation.action === "reparse") {
                  reparse.mutate(
                    { expectedContentRevision: confirmation.contentRevision },
                    {
                      onSuccess: () => {
                        setConfirmation(null)
                        toast.success(
                          "重新解析已排队，请确保文档 Worker 已启动"
                        )
                      },
                    }
                  )
                } else {
                  deletion.mutate(undefined, {
                    onSuccess: () => {
                      setConfirmation(null)
                      onDeleted?.()
                      toast.success("文档已删除，原件和图片由 Worker 后续清理")
                    },
                  })
                }
              }}
            >
              {changingDocument && <LoaderCircle className="animate-spin" />}
              {confirmation?.action === "reparse" ? "确认重新解析" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}

type DocumentDraft = SaveKnowledgeDocumentContentInput & { baseContent: string }

/** 保存过程中还能输入；只清除已提交的草稿，新输入必须接着使用服务器返回的版本。 */
export function reconcileSavedDraft(
  draft: DocumentDraft | null,
  submitted: SaveKnowledgeDocumentContentInput,
  saved: Pick<KnowledgeDocument, "markdownContent" | "contentRevision">
): DocumentDraft | null {
  if (
    !draft ||
    draft.markdownContent === submitted.markdownContent ||
    draft.markdownContent === saved.markdownContent
  )
    return null
  return {
    ...draft,
    baseContent: saved.markdownContent ?? "",
    expectedContentRevision: saved.contentRevision,
  }
}

/** 三种显示模式共用一份本地草稿；Query 缓存只保存已经落库的正文。 */
export function DocumentEditor({
  document,
  reloading,
  onReload,
  onLeaveGuardChange,
}: {
  document: KnowledgeDocument
  reloading: boolean
  onReload: () => Promise<void>
  onLeaveGuardChange?: (guard: () => boolean) => void
}) {
  const [mode, setMode] = useState<"read" | "edit" | "split">("read")
  const [draft, setDraft] = useState<DocumentDraft | null>(null)
  const [autoSave, setAutoSave] = useState(false)
  const saving = useSaveKnowledgeDocumentContent(document.id)
  const { mutate } = saving
  // 互斥锁防止自动保存与快捷键在同一渲染周期内同时提交，不作为另一份界面状态。
  const inFlight = useRef(false)
  const content = draft?.markdownContent ?? document.markdownContent ?? ""
  const dirty = draft !== null && draft.markdownContent !== draft.baseContent
  const conflict =
    saving.error instanceof KnowledgeRequestError && saving.error.status === 409

  const save = useCallback(() => {
    if (!draft || !dirty || inFlight.current || reloading || conflict) return
    inFlight.current = true
    mutate(
      {
        markdownContent: draft.markdownContent,
        expectedContentRevision: draft.expectedContentRevision,
      },
      {
        onSuccess: (data, submitted) =>
          setDraft((current) =>
            reconcileSavedDraft(current, submitted, data.document)
          ),
        onSettled: () => {
          inFlight.current = false
        },
      }
    )
  }, [draft, dirty, reloading, conflict, mutate])

  // 自动保存仅由用户开启；错误后停止，避免版本冲突或断网时重复提交。
  useEffect(() => {
    if (!autoSave || !dirty || saving.isPending || saving.isError || reloading)
      return
    const timer = window.setTimeout(save, 1200)
    return () => window.clearTimeout(timer)
  }, [autoSave, dirty, saving.isPending, saving.isError, reloading, save])

  // 快捷键支持 Windows/Linux 的 Ctrl+S 和 macOS 的 Cmd+S。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [save])

  // 父页面在切换文档/知识库前调用此守卫；刷新或关闭页面由浏览器提示。
  useEffect(() => {
    const unsaved = dirty || saving.isPending
    onLeaveGuardChange?.(() => {
      if (saving.isPending || inFlight.current) {
        toast.error("请等待正文保存完成后再操作")
        return false
      }
      return !dirty || window.confirm("正文尚未保存，确定离开并放弃草稿吗？")
    })
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsaved) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      onLeaveGuardChange?.(() => true)
    }
  }, [dirty, saving.isPending, onLeaveGuardChange])

  async function reload() {
    if (
      dirty &&
      !window.confirm("重新加载会放弃当前草稿，是否继续？建议先复制本地内容。")
    )
      return
    try {
      await onReload()
      setDraft(null)
      saving.reset()
    } catch (error) {
      // 读取失败不清草稿，也不解除冲突锁定。
      toast.error(error instanceof Error ? error.message : "重新加载失败")
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(content)
      toast.success("本地内容已复制")
    } catch {
      toast.error("复制失败，请在编辑框中手动选中并复制")
    }
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3"
      aria-label="Markdown 编辑与保存"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="文档显示模式">
          {(["read", "edit", "split"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {{ read: "阅读", edit: "编辑", split: "分屏" }[value]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(event) => setAutoSave(event.target.checked)}
            />
            自动保存
          </label>
          <span role="status" className="text-xs text-muted-foreground">
            {saving.isPending
              ? "保存中…"
              : dirty
                ? "有未保存修改"
                : saving.isSuccess
                  ? "已保存"
                  : "无未保存修改"}
          </span>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || saving.isPending || reloading || conflict}
          >
            {saving.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Save />
            )}
            保存
          </Button>
        </div>
      </div>
      {saving.isError && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p className="text-destructive">{saving.error.message}</p>
          <p className="text-muted-foreground">
            {conflict
              ? "本地草稿已保留，请复制后重新加载最新正文，再合并修改。"
              : "草稿已保留，自动保存已暂停，请手动重试。"}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={copyDraft}>
              <Copy />
              复制本地内容
            </Button>
            {conflict ? (
              <Button
                size="sm"
                variant="outline"
                disabled={reloading}
                onClick={reload}
              >
                重新加载正文
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={saving.isPending || reloading}
                onClick={save}
              >
                重试保存
              </Button>
            )}
          </div>
        </div>
      )}
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4",
          mode === "split" && "md:grid-cols-2"
        )}
      >
        {mode !== "read" && (
          <Textarea
            aria-label="Markdown 正文"
            value={content}
            maxLength={MAX_MARKDOWN_CHARACTERS}
            disabled={reloading}
            spellCheck={false}
            className="[field-sizing:fixed] h-full min-h-60 resize-none overflow-auto font-mono"
            onChange={(event) => {
              const markdownContent = event.target.value
              const baseContent =
                draft?.baseContent ?? document.markdownContent ?? ""
              // 提交过程中即使用户撤回到旧正文，也保留该输入，不能被迟到的保存结果抹掉。
              setDraft(
                markdownContent === baseContent && !inFlight.current
                  ? null
                  : {
                      markdownContent,
                      baseContent,
                      expectedContentRevision:
                        draft?.expectedContentRevision ??
                        document.contentRevision,
                    }
              )
            }}
          />
        )}
        {mode !== "edit" && (
          <div className="min-h-0 min-w-0 overflow-auto">
            {content ? (
              <KnowledgeMarkdown documentId={document.id} content={content} />
            ) : (
              <p className="text-sm text-muted-foreground">
                正文为空，可切换到编辑模式填写。
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
