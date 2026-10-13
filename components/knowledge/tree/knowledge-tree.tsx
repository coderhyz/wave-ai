"use client"

import { useState } from "react"
import { FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  useRenameKnowledgeFolder,
  useRenameKnowledgeDocument,
  useDeleteKnowledgeFolder,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeBase,
} from "@/hooks/use-knowledge"
import { toast } from "sonner"
import { KnowledgeNameDialog } from "../knowledge-name-dialog"
import { KnowledgeDeleteDialog } from "./knowledge-delete-dialog"
import {
  KnowledgeItemMenu,
  type TreeItem,
  type TreeAction,
} from "./knowledge-item-menu"
import { KnowledgeTreeBranch, type BranchProps } from "./knowledge-tree-branch"

type TreeProps = Omit<BranchProps, "onAction"> & {
  onSelectionDeleted: (clearFolder: boolean) => void
  onKnowledgeBaseDeleted: () => void
}

/** 目录父组件统一管理重命名和删除；子组件只展示节点并上报操作。 */
export function KnowledgeTreeView(props: TreeProps) {
  // 所有节点共用一个操作目标和一组 Mutation，避免每个文件都挂载独立弹窗。
  const [action, setAction] = useState<{
    item: TreeItem
    type: TreeAction
  } | null>(null)
  const baseId = props.tree.knowledgeBase.id
  const targetId = action?.item.id ?? ""
  const renameFolder = useRenameKnowledgeFolder(targetId, baseId)
  const renameDocument = useRenameKnowledgeDocument(targetId)
  const deleteFolder = useDeleteKnowledgeFolder(targetId, baseId)
  const deleteDocument = useDeleteKnowledgeDocument(targetId)
  const deleteBase = useDeleteKnowledgeBase(baseId)
  const rename = action?.item.kind === "folder" ? renameFolder : renameDocument
  const deletion =
    action?.item.kind === "base"
      ? deleteBase
      : action?.item.kind === "folder"
        ? deleteFolder
        : deleteDocument
  const mutation = action?.type === "rename" ? rename : deletion

  function openAction(item: TreeItem, type: TreeAction) {
    // 新操作不能沿用上一项的错误或成功状态；失败时仍保留当前目标供用户重试。
    renameFolder.reset()
    renameDocument.reset()
    deleteFolder.reset()
    deleteDocument.reset()
    deleteBase.reset()
    setAction({ item, type })
  }

  function remove() {
    if (!action) return
    const { item } = action
    if (item.kind === "base") {
      deleteBase.mutate(undefined, {
        onSuccess: () => {
          setAction(null)
          props.onKnowledgeBaseDeleted()
          toast.success("知识库已删除，系统将清理原件和图片")
        },
      })
    } else if (item.kind === "folder") {
      deleteFolder.mutate(undefined, {
        onSuccess: ({ deleted }) => {
          // 以服务端实际删除范围为准，其他目录的选择不受影响。
          const folderDeleted = deleted.folderIds.includes(
            props.selectedFolderId ?? ""
          )
          if (
            folderDeleted ||
            deleted.documentIds.includes(props.selectedDocumentId)
          )
            props.onSelectionDeleted(folderDeleted)
          setAction(null)
          toast.success("目录及其中的文件已删除，Worker 将清理原件和图片")
        },
      })
    } else {
      deleteDocument.mutate(undefined, {
        onSuccess: () => {
          if (item.id === props.selectedDocumentId)
            props.onSelectionDeleted(false)
          setAction(null)
          toast.success("文件已删除，Worker 将清理原件和图片")
        },
      })
    }
  }

  return (
    <>
      <nav aria-label="知识库文件目录" className="space-y-1">
        <div className="group flex items-center rounded-md">
          <Button
            variant="ghost"
            className={cn(
              "min-w-0 flex-1 justify-start",
              props.selectedFolderId === null && "bg-muted"
            )}
            aria-pressed={props.selectedFolderId === null}
            onClick={() => props.onSelectFolder(null)}
          >
            <FolderOpen />
            根目录
          </Button>
          <KnowledgeItemMenu
            item={{
              kind: "base",
              id: baseId,
              name: props.tree.knowledgeBase.name,
            }}
            onAction={openAction}
          />
        </div>
        <KnowledgeTreeBranch {...props} parentId={null} onAction={openAction} />
        {props.tree.folders.length === 0 &&
          props.tree.documents.length === 0 && (
            <p className="px-3 py-6 text-sm text-muted-foreground">
              还没有文件，上传一份文档开始吧。
            </p>
          )}
      </nav>
      {action?.type === "rename" && (
        <KnowledgeNameDialog
          key={`${action.item.kind}:${action.item.id}`}
          title={action.item.kind === "folder" ? "重命名目录" : "重命名文件"}
          description="只修改显示名称，不改变目录位置或 OSS 原件。"
          defaultName={action.item.name}
          submitLabel="保存"
          maxLength={action.item.kind === "folder" ? 100 : 255}
          pending={mutation.isPending}
          error={mutation.error?.message}
          onClose={() => setAction(null)}
          onSubmit={(name) => {
            const options = {
              onSuccess: () => {
                setAction(null)
                toast.success("名称已更新")
              },
            }
            if (action.item.kind === "folder")
              renameFolder.mutate({ name }, options)
            else renameDocument.mutate({ title: name }, options)
          }}
        />
      )}
      <KnowledgeDeleteDialog
        open={action?.type === "delete"}
        item={action?.item}
        pending={mutation.isPending}
        error={mutation.error?.message}
        onClose={() => setAction(null)}
        onConfirm={remove}
      />
    </>
  )
}
