"use client"

import { useCallback, useRef, useState } from "react"
import { parseAsString, useQueryStates } from "nuqs"
import {
  BookOpen,
  FolderPlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  useCreateKnowledgeBase,
  useCreateKnowledgeFolder,
  useKnowledgeBases,
  useKnowledgeTree,
  useUploadKnowledgeDocument,
} from "@/hooks/use-knowledge"
import { KnowledgeTreeView } from "./knowledge-tree"
import { DocumentPreview } from "./document-preview"
import { FilePreview } from "./file-preview"
import { KnowledgeNameDialog } from "./knowledge-name-dialog"

/** URL 保留选择；本地未保存草稿通过编辑器注册的离开守卫保护。 */
export function KnowledgeWorkspace() {
  const [selection, setSelection] = useQueryStates({
    base: parseAsString.withDefault(""),
    folder: parseAsString.withDefault(""),
    document: parseAsString.withDefault(""),
  })
  const bases = useKnowledgeBases()
  const createBase = useCreateKnowledgeBase()
  const [creatingBase, setCreatingBase] = useState(false)
  const leaveDocument = useRef<() => boolean>(() => true)
  // 传给编辑器 Effect 的注册函数保持稳定，避免无关渲染反复注销守卫。
  const registerLeaveGuard = useCallback((guard: () => boolean) => {
    leaveDocument.current = guard
  }, [])
  // 默认知识库直接从列表推导，不额外用 Effect 同步一份远端状态。
  const knowledgeBaseId = selection.base || bases.data?.items[0]?.id || ""
  // 父级也需要禁用切库按钮，直接复用上传 Mutation 的状态，不维护第二份 busy。
  const upload = useUploadKnowledgeDocument(knowledgeBaseId)
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <BookOpen className="size-5" />
            知识库
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            上传文件即可预览原件，解析后可编辑 Markdown 正文。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={knowledgeBaseId}
            disabled={bases.isPending || upload.isPending}
            onValueChange={(base) => {
              if (!leaveDocument.current()) return
              upload.reset()
              setSelection({ base, folder: "", document: "" })
            }}
          >
            <SelectTrigger aria-label="选择知识库" className="w-48">
              <SelectValue placeholder="选择知识库" />
            </SelectTrigger>
            <SelectContent>
              {bases.data?.items.map((base) => (
                <SelectItem key={base.id} value={base.id}>
                  {base.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={upload.isPending}
            onClick={() => {
              createBase.reset()
              setCreatingBase(true)
            }}
          >
            <Plus />
            新建知识库
          </Button>
        </div>
      </div>
      {bases.isPending && (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          正在加载知识库…
        </p>
      )}
      {bases.isError && (
        <div role="alert" className="space-y-3 p-6">
          <p className="text-sm text-destructive">{bases.error.message}</p>
          <Button variant="outline" onClick={() => bases.refetch()}>
            重新加载
          </Button>
        </div>
      )}
      {bases.isSuccess && !knowledgeBaseId && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
          <BookOpen className="size-10 text-muted-foreground" />
          <h2 className="font-medium">创建你的第一个知识库</h2>
          <p className="text-sm text-muted-foreground">
            按主题整理文件，上传后即可预览原件。
          </p>
        </div>
      )}
      {bases.data && knowledgeBaseId && (
        <BaseWorkspace
          key={knowledgeBaseId}
          knowledgeBaseId={knowledgeBaseId}
          folderId={selection.folder || null}
          documentId={selection.document}
          onSelect={(folder, document) => {
            if (document !== selection.document && !leaveDocument.current())
              return false
            setSelection({
              base: knowledgeBaseId,
              folder: folder ?? "",
              document,
            })
            return true
          }}
          onLeaveGuardChange={registerLeaveGuard}
          // 删除前已确认草稿，成功后直接清空选择，不再次触发离开提示。
          onDeleted={() => setSelection({ document: "" })}
          onSelectionDeleted={(clearFolder) =>
            setSelection({
              document: "",
              ...(clearFolder ? { folder: "" } : {}),
            })
          }
          onKnowledgeBaseDeleted={() =>
            setSelection({ base: "", folder: "", document: "" })
          }
          canLeaveDocument={() => leaveDocument.current()}
          upload={upload}
        />
      )}
      {creatingBase && (
        <KnowledgeNameDialog
          title="新建知识库"
          description="知识库仅对当前账户可见。"
          pending={createBase.isPending}
          error={createBase.error?.message}
          onClose={() => setCreatingBase(false)}
          onSubmit={(name) =>
            createBase.mutate(name, {
              onSuccess: ({ knowledgeBase }) => {
                if (leaveDocument.current())
                  setSelection({
                    base: knowledgeBase.id,
                    folder: "",
                    document: "",
                  })
                setCreatingBase(false)
              },
            })
          }
        />
      )}
    </section>
  )
}

/** 切换知识库时重新挂载，清除上一座知识库的目录展开和创建表单。 */
function BaseWorkspace({
  knowledgeBaseId,
  folderId,
  documentId,
  onSelect,
  upload,
  onLeaveGuardChange,
  onDeleted,
  onSelectionDeleted,
  onKnowledgeBaseDeleted,
  canLeaveDocument,
}: {
  knowledgeBaseId: string
  folderId: string | null
  documentId: string
  onSelect: (folderId: string | null, documentId: string) => boolean
  upload: ReturnType<typeof useUploadKnowledgeDocument>
  onLeaveGuardChange: (guard: () => boolean) => void
  onDeleted: () => void
  onSelectionDeleted: (clearFolder: boolean) => void
  onKnowledgeBaseDeleted: () => void
  canLeaveDocument: () => boolean
}) {
  const tree = useKnowledgeTree(knowledgeBaseId)
  const createFolder = useCreateKnowledgeFolder(knowledgeBaseId)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [previewDocumentId, setPreviewDocumentId] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const folderName =
    folderId === null
      ? "根目录"
      : tree.data?.folders.find((folder) => folder.id === folderId)?.name
  function selectDocument(id: string, folder: string | null) {
    // 文档组件按类型直接预览；清除 MD 手动打开的原件视图，避免切文件后残留。
    if (onSelect(folder, id)) setPreviewDocumentId("")
  }
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,35%)_1fr] overflow-hidden rounded-xl border bg-background md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-1">
      <aside className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
        <div className="space-y-3 border-b p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">文件目录</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="刷新文件目录"
              disabled={tree.isFetching}
              onClick={() => tree.refetch()}
            >
              <RefreshCw className={tree.isFetching ? "animate-spin" : ""} />
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={!tree.isSuccess || upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Upload />
              )}
              {upload.isPending ? "上传中" : "上传文件"}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="新建文件夹"
              disabled={!tree.isSuccess || upload.isPending}
              onClick={() => {
                createFolder.reset()
                setCreatingFolder(true)
              }}
            >
              <FolderPlus />
            </Button>
          </div>
          <p
            className="truncate text-xs text-muted-foreground"
            title={folderName}
          >
            上传到：{folderName}
          </p>
          <p className="text-xs text-muted-foreground">
            PDF / DOCX / TXT / MD，单文件 ≤ 20 MB
          </p>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept=".pdf,.docx,.txt,.md,.markdown"
            aria-label="上传知识库文档"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (!file) return
              // 上传期间禁止切库，避免异步完成后把选择写到另一座知识库。
              upload.mutate(
                { file, folderId },
                {
                  onSuccess: ({ document }) =>
                    selectDocument(document.id, document.folderId),
                }
              )
            }}
          />
          {upload.isError && (
            <p role="alert" className="text-xs break-words text-destructive">
              {upload.error.message}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {tree.isPending && (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              正在加载目录…
            </p>
          )}
          {tree.isError && (
            <div role="alert" className="space-y-2 p-3">
              <p className="text-sm text-destructive">{tree.error.message}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => tree.refetch()}
              >
                重新加载
              </Button>
            </div>
          )}
          {tree.isSuccess && (
            <KnowledgeTreeView
              tree={tree.data}
              selectedFolderId={folderId}
              selectedDocumentId={documentId}
              onSelectFolder={(id) => {
                if (onSelect(id, "")) setPreviewDocumentId("")
              }}
              onSelectDocument={selectDocument}
              canLeaveDocument={canLeaveDocument}
              onSelectionDeleted={(clearFolder) => {
                setPreviewDocumentId("")
                // 删除前已检查草稿，成功后直接清空选择，不再次触发离开确认。
                onSelectionDeleted(clearFolder)
              }}
              onKnowledgeBaseDeleted={onKnowledgeBaseDeleted}
            />
          )}
        </div>
      </aside>
      <div className="min-h-0 min-w-0">
        {/* 只隐藏正文，不卸载编辑器，避免查看原件时丢失未保存的输入。 */}
        <div hidden={Boolean(previewDocumentId)} className="h-full min-h-0">
          <DocumentPreview
            key={documentId}
            documentId={documentId}
            onLeaveGuardChange={onLeaveGuardChange}
            onDeleted={onDeleted}
            onPreviewOriginal={() => setPreviewDocumentId(documentId)}
          />
        </div>
        {previewDocumentId && (
          <FilePreview
            key={previewDocumentId}
            documentId={previewDocumentId}
            onClose={() => setPreviewDocumentId("")}
          />
        )}
      </div>
      {creatingFolder && (
        <KnowledgeNameDialog
          title="新建文件夹"
          description={`创建到：${folderName}`}
          pending={createFolder.isPending}
          error={createFolder.error?.message}
          onClose={() => setCreatingFolder(false)}
          onSubmit={(name) =>
            createFolder.mutate(
              { name, parentId: folderId },
              {
                onSuccess: ({ folder }) => {
                  onSelect(folder.id, "")
                  setCreatingFolder(false)
                },
              }
            )
          }
        />
      )}
    </div>
  )
}
