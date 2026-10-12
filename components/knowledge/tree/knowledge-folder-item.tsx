"use client"

import { useState, type ReactNode } from "react"
import { ChevronRight, Folder, FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { KnowledgeTree } from "@/hooks/use-knowledge"
import {
  KnowledgeItemMenu,
  type TreeItem,
  type TreeAction,
} from "./knowledge-item-menu"

/** 展开和选择分开操作：选择目录用于指定上传位置，不必改变展开状态。 */
export function KnowledgeFolderItem({
  folder,
  isSelected,
  onSelect,
  onAction,
  children,
}: {
  folder: KnowledgeTree["folders"][number]
  isSelected: boolean
  onSelect: (id: string) => void
  onAction: (item: TreeItem, type: TreeAction) => void
  children?: ReactNode
}) {
  // 使用目录 ID 作为 React key，刷新目录摘要不会重置用户的展开选择。
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div className="group flex items-center rounded-md">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${open ? "收起" : "展开"}${folder.name}`}
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
            isSelected && "bg-muted"
          )}
          aria-pressed={isSelected}
          onClick={() => onSelect(folder.id)}
        >
          {open ? <FolderOpen /> : <Folder />}
          <span className="truncate" title={folder.name}>
            {folder.name}
          </span>
        </Button>
        <KnowledgeItemMenu
          item={{
            kind: "folder",
            id: folder.id,
            name: folder.name,
          }}
          onAction={onAction}
        />
      </div>
      {open && <div className="ml-3 border-l pl-2">{children}</div>}
    </div>
  )
}
