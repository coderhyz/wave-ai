"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  Download,
  Eye,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  MessageCircle,
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
import { DocumentChat } from "./document-chat"
import { KnowledgeMarkdown } from "./knowledge-markdown"

/** MD 只读展示解析正文，其他文件直接预览 OSS 原件，不等待解析完成。 */
export function DocumentPreview({
  documentId,
  onDeleted,
  onPreviewOriginal,
}: {
  documentId: string
  onDeleted?: () => void
  onPreviewOriginal?: () => void
}) {
  const [showChat, setShowChat] = useState(true)
  const [chatExpanded, setChatExpanded] = useState(false)
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
          <Button
            variant="outline"
            size="sm"
            aria-expanded={showChat}
            onClick={() => {
              setShowChat((open) => !open)
              setChatExpanded(false)
            }}
          >
            <MessageCircle />
            {showChat ? "收起问答" : "文档问答"}
          </Button>
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
          {!showOriginal && " · Markdown 文档"}
        </p>
        {/* 后台读取失败时保留已加载的正文，并明确显示错误。 */}
        {query.isError && (
          <p role="alert" className="text-sm text-destructive">
            读取最新正文失败：{query.error.message}
          </p>
        )}
      </div>
      <div
        className={
          showChat && !chatExpanded
            ? "grid min-h-0 flex-1 grid-rows-2 xl:grid-cols-[minmax(0,1fr)_minmax(320px,40%)] xl:grid-rows-1"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        <div
          className={
            showChat && chatExpanded
              ? "hidden"
              : "flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-5 md:p-8"
          }
        >
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
          {!showOriginal &&
            document.status === "READY" &&
            (document.markdownContent ? (
              <KnowledgeMarkdown
                content={document.markdownContent}
                documentId={document.id}
              />
            ) : (
              <p className="text-sm text-muted-foreground">文档正文为空</p>
            ))}
        </div>
        {showChat && (
          <aside
            className={
              chatExpanded
                ? "min-h-0 min-w-0 flex-1 overflow-hidden"
                : "min-h-0 min-w-0 overflow-hidden border-t xl:border-t-0 xl:border-l"
            }
          >
            <DocumentChat
              documentId={documentId}
              expanded={chatExpanded}
              onToggleExpand={() => setChatExpanded((expanded) => !expanded)}
              ready={
                document.status === "READY" &&
                document.chunkStatus === "READY" &&
                document.chunkedContentRevision === document.contentRevision
              }
            />
          </aside>
        )}
      </div>
      {/* 删除和重解析仍需确认，操作失败时保留对话框供用户重试。 */}
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
                ? `将从原件重新解析「${document.title}」。成功后更新当前正文；失败不会清除现有正文。`
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
                if (!confirmation) return
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
