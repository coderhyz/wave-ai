"use client"

import { useState } from "react"
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
  LoaderCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  useRenameKnowledgeFolder,
  useRenameKnowledgeDocument,
  useDeleteKnowledgeFolder,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeBase,
  type KnowledgeDocument,
  type KnowledgeTree,
} from "@/hooks/use-knowledge"
import { toast } from "sonner"
import { KnowledgeNameDialog } from "./knowledge-name-dialog"
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

type TreeItem = {
  kind: "base" | "folder" | "document"
  id: string
  name: string
}
type TreeAction = "rename" | "delete"

export const documentStatusLabels = {
  QUEUED: "排队中",
  PARSING: "解析中",
  READY: "可阅读",
  FAILED: "解析失败",
} satisfies Record<KnowledgeDocument["status"], string>

type TreeProps = {
  tree: KnowledgeTree
  selectedFolderId: string | null
  selectedDocumentId: string
  onSelectFolder: (id: string | null) => void
  onSelectDocument: (id: string, folderId: string | null) => void
  canLeaveDocument: () => boolean
  onSelectionDeleted: (clearFolder: boolean) => void
  onKnowledgeBaseDeleted: () => void
}

/** 目录展开属于局部 UI 状态，文件及解析状态始终来自 Query 缓存。 */
export function KnowledgeTreeView(props: TreeProps) {
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
    const selectedDocument = props.tree.documents.find(
      ({ id }) => id === props.selectedDocumentId
    )
    let affectsSelection =
      item.kind === "base" ||
      (item.kind === "document" && item.id === props.selectedDocumentId)
    if (item.kind === "folder") {
      // 删除祖先目录也会带走当前文件；只在删除范围覆盖当前选择时检查未保存草稿。
      for (let folderId of [
        props.selectedFolderId,
        selectedDocument?.folderId,
      ]) {
        while (folderId) {
          if (folderId === item.id) {
            affectsSelection = true
            break
          }
          folderId = props.tree.folders.find(
            ({ id }) => id === folderId
          )?.parentId
        }
      }
    }
    if (affectsSelection && !props.canLeaveDocument()) return
    if (item.kind === "base") {
      deleteBase.mutate(undefined, {
        onSuccess: () => {
          setAction(null)
          props.onKnowledgeBaseDeleted()
          toast.success("知识库已删除，Worker 将清理原件和图片")
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
          <ItemMenu
            item={{
              kind: "base",
              id: baseId,
              name: props.tree.knowledgeBase.name,
            }}
            onAction={openAction}
          />
        </div>
        <TreeBranch {...props} parentId={null} onAction={openAction} />
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
      <Dialog
        open={action?.type === "delete"}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setAction(null)
        }}
      >
        <DialogContent showCloseButton={!mutation.isPending}>
          <DialogHeader>
            <DialogTitle>
              {action?.item.kind === "base"
                ? "删除整个知识库？"
                : action?.item.kind === "folder"
                  ? "删除目录及其文件？"
                  : "删除文件？"}
            </DialogTitle>
            <DialogDescription>
              {action?.item.kind === "base"
                ? `将删除知识库「${action.item.name}」及其中所有目录、文件。`
                : action?.item.kind === "folder"
                  ? `将删除目录「${action.item.name}」及全部子目录和文件。`
                  : `将删除文件「${action?.item.name}」。`}
              此操作不可撤销，原件和解析图片将彻底删除。
            </DialogDescription>
          </DialogHeader>
          {mutation.error && (
            <p role="alert" className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setAction(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={remove}
            >
              {mutation.isPending && <LoaderCircle className="animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 菜单按钮与选择按钮并列，避免嵌套 button 或误触文件预览；没有置顶操作。 */
function ItemMenu({
  item,
  onAction,
}: {
  item: TreeItem
  onAction: (item: TreeItem, type: TreeAction) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${item.kind === "base" ? "根目录" : item.name}操作`}
          className="shrink-0 data-[state=open]:opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {item.kind !== "base" && (
          <>
            <DropdownMenuItem onSelect={() => onAction(item, "rename")}>
              <Pencil />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onAction(item, "delete")}
        >
          <Trash2 />
          {item.kind === "base"
            ? "删除知识库"
            : item.kind === "folder"
              ? "删除目录"
              : "删除文件"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 按 parentId 直接从接口摘要派生同级节点，不另存一份树状数据。 */
type BranchProps = TreeProps & {
  onAction: (item: TreeItem, type: TreeAction) => void
}
function TreeBranch(props: BranchProps & { parentId: string | null }) {
  return (
    <>
      {props.tree.folders
        .filter((folder) => folder.parentId === props.parentId)
        .map((folder) => (
          <FolderBranch key={folder.id} {...props} folder={folder} />
        ))}
      {props.tree.documents
        .filter((document) => document.folderId === props.parentId)
        .map((document) => (
          <div key={document.id} className="group flex items-center rounded-md">
            <Button
              variant="ghost"
              className={cn(
                "h-auto min-h-9 min-w-0 flex-1 justify-start py-2",
                props.selectedDocumentId === document.id &&
                "bg-accent text-accent-foreground"
              )}
              aria-pressed={props.selectedDocumentId === document.id}
              onClick={() =>
                props.onSelectDocument(document.id, document.folderId)
              }
            >
              <FileText className="shrink-0 text-muted-foreground" />
              <span
                className="min-w-0 flex-1 truncate text-left"
                title={document.title}
              >
                {document.title}
              </span>
              {document.status !== "READY" && (
                <Badge
                  variant={
                    document.status === "FAILED" ? "destructive" : "secondary"
                  }
                >
                  {documentStatusLabels[document.status]}
                </Badge>
              )}
            </Button>
            <ItemMenu
              item={{ kind: "document", id: document.id, name: document.title }}
              onAction={props.onAction}
            />
          </div>
        ))}
    </>
  )
}

/** 展开和选择分开操作：选择目录用于指定上传位置，不必改变展开状态。 */
function FolderBranch(
  props: BranchProps & { folder: KnowledgeTree["folders"][number] }
) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div className="group flex items-center rounded-md">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${open ? "收起" : "展开"}${props.folder.name}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight
            className={cn("transition-transform", open && "rotate-90")}
          />
        </Button>
        <Button
          variant="ghost"
          className={cn(
            "min-w-0 flex-1 justify-start",
            props.selectedFolderId === props.folder.id && "bg-muted"
          )}
          aria-pressed={props.selectedFolderId === props.folder.id}
          onClick={() => props.onSelectFolder(props.folder.id)}
        >
          {open ? <FolderOpen /> : <Folder />}
          <span className="truncate" title={props.folder.name}>
            {props.folder.name}
          </span>
        </Button>
        <ItemMenu
          item={{
            kind: "folder",
            id: props.folder.id,
            name: props.folder.name,
          }}
          onAction={props.onAction}
        />
      </div>
      {open && (
        <div className="ml-3 border-l pl-2">
          <TreeBranch {...props} parentId={props.folder.id} />
        </div>
      )}
    </div>
  )
}
