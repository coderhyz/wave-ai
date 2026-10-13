"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  useCreateKnowledgeFolder,
  useKnowledgeTree,
  type useUploadKnowledgeDocument,
} from "@/hooks/use-knowledge"
import { KnowledgeTreeView } from "../tree/knowledge-tree"
import { DocumentPreview } from "../document/document-preview"
import { FilePreview } from "../preview/file-preview"
import { KnowledgeNameDialog } from "../knowledge-name-dialog"
import { KnowledgeUploadToolbar } from "./knowledge-upload-toolbar"

/** 切换知识库时重新挂载，清除上一座知识库的目录展开和创建表单。 */
export function KnowledgeBaseWorkspace({
  knowledgeBaseId,
  folderId,
  documentId,
  onSelect,
  upload,
  onDeleted,
  onSelectionDeleted,
  onKnowledgeBaseDeleted,
}: {
  knowledgeBaseId: string
  folderId: string | null
  documentId: string
  onSelect: (folderId: string | null, documentId: string) => void
  upload: ReturnType<typeof useUploadKnowledgeDocument>
  onDeleted: () => void
  onSelectionDeleted: (clearFolder: boolean) => void
  onKnowledgeBaseDeleted: () => void
}) {
  const tree = useKnowledgeTree(knowledgeBaseId)
  const createFolder = useCreateKnowledgeFolder(knowledgeBaseId)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [previewDocumentId, setPreviewDocumentId] = useState("")
  const folderName =
    folderId === null
      ? "根目录"
      : tree.data?.folders.find((folder) => folder.id === folderId)?.name
  function selectDocument(id: string, folder: string | null) {
    // 文档组件按类型直接预览；清除 MD 手动打开的原件视图，避免切文件后残留。
    onSelect(folder, id)
    setPreviewDocumentId("")
  }
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,35%)_1fr] overflow-hidden rounded-xl border bg-background md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-1">
      <aside className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
        <KnowledgeUploadToolbar
          folderId={folderId}
          folderName={folderName}
          upload={upload}
          treeReady={tree.isSuccess}
          refreshing={tree.isFetching}
          onRefresh={() => tree.refetch()}
          onCreateFolder={() => {
            createFolder.reset()
            setCreatingFolder(true)
          }}
          onUploaded={selectDocument}
        />
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
                onSelect(id, "")
                setPreviewDocumentId("")
              }}
              onSelectDocument={selectDocument}
              onSelectionDeleted={(clearFolder) => {
                setPreviewDocumentId("")
                onSelectionDeleted(clearFolder)
              }}
              onKnowledgeBaseDeleted={onKnowledgeBaseDeleted}
            />
          )}
        </div>
      </aside>
      <div className="min-h-0 min-w-0">
        {previewDocumentId ? (
          <FilePreview
            key={previewDocumentId}
            documentId={previewDocumentId}
            onClose={() => setPreviewDocumentId("")}
          />
        ) : (
          <DocumentPreview
            key={documentId}
            documentId={documentId}
            onDeleted={onDeleted}
            onPreviewOriginal={() => setPreviewDocumentId(documentId)}
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
