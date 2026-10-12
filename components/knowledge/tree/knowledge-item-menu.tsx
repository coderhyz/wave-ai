"use client"

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// 菜单只需要节点身份和显示名，不携带正文或存储信息。
export type TreeItem = {
  kind: "base" | "folder" | "document"
  id: string
  name: string
}
export type TreeAction = "rename" | "delete"

/** 菜单按钮与选择按钮并列，避免嵌套 button 或误触文件预览；没有置顶操作。 */
export function KnowledgeItemMenu({
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
