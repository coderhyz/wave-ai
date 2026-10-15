"use client"

import { useRef } from "react"
import { FolderPlus, LoaderCircle, RefreshCw, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { useUploadKnowledgeDocument } from "@/hooks/use-knowledge"

/** 上传控件复用父级 Mutation，使上传中禁用切库与按钮共用同一个状态。 */
export function KnowledgeUploadToolbar({
  folderId,
  folderName,
  upload,
  treeReady,
  refreshing,
  onRefresh,
  onCreateFolder,
  onUploaded,
}: {
  folderId: string | null
  folderName?: string
  upload: ReturnType<typeof useUploadKnowledgeDocument>
  treeReady: boolean
  refreshing: boolean
  onRefresh: () => void
  onCreateFolder: () => void
  onUploaded: (id: string, folderId: string | null) => void
}) {
  // 隐藏 input 只属于上传按钮，不把 DOM 引用传到工作区。
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <div className="space-y-3 border-b p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">文件目录</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新文件目录"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={!treeReady || upload.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Upload />
          )}
          {upload.isPending ? "上传并处理中" : "上传文件"}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="新建文件夹"
          disabled={!treeReady || upload.isPending}
          onClick={onCreateFolder}
        >
          <FolderPlus />
        </Button>
      </div>
      <p className="truncate text-xs text-muted-foreground" title={folderName}>
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
                onUploaded(document.id, document.folderId),
            }
          )
        }}
      />
      {upload.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          正在上传并解析文件、建立索引，大文件可能需要几分钟，请保持页面打开。
        </p>
      )}
      {upload.isError && (
        <p role="alert" className="text-xs break-words text-destructive">
          {upload.error.message}
        </p>
      )}
    </div>
  )
}
