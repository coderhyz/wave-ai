"use client"

import { useCallback, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  Download,
  Eye,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import {
  KnowledgeRequestError,
  useKnowledgeDocument,
  useReparseKnowledgeDocument,
  useDeleteKnowledgeDocument,
  downloadKnowledgeDocumentOriginal,
} from "@/hooks/use-knowledge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { documentStatusLabels } from "../tree/knowledge-document-item"
import { FilePreview } from "../preview/file-preview"
import { DocumentEditor } from "./document-editor"

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
  // 确认框记录打开时的正文版本，不能用后台刷新的新版本悄悄替换用户确认的版本。
  const [confirmation, setConfirmation] = useState<{
    action: "reparse" | "delete"
    contentRevision: number
  } | null>(null)
  const leaveGuard = useRef<() => boolean>(() => true)
  // 同一守卫同时用于文档操作和外层切换，保存中的请求不能被删除或重解析打断。
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
