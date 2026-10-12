"use client"

import { FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { KnowledgeDocument, KnowledgeTree } from "@/hooks/use-knowledge"
import {
  KnowledgeItemMenu,
  type TreeItem,
  type TreeAction,
} from "./knowledge-item-menu"

// 文件行和阅读区共用状态文案，不各自维护一份映射。
export const documentStatusLabels = {
  QUEUED: "排队中",
  PARSING: "解析中",
  READY: "可阅读",
  FAILED: "解析失败",
} satisfies Record<KnowledgeDocument["status"], string>

/** 单个文件只负责展示与事件通知；请求和确认框由目录父组件统一管理。 */
export function KnowledgeDocumentItem({
  document,
  isSelected,
  onSelect,
  onAction,
}: {
  document: KnowledgeTree["documents"][number]
  isSelected: boolean
  onSelect: (id: string, folderId: string | null) => void
  onAction: (item: TreeItem, type: TreeAction) => void
}) {
  return (
    <div className="group flex items-center rounded-md">
      <Button
        variant="ghost"
        className={cn(
          "h-auto min-h-9 min-w-0 flex-1 justify-start py-2",
          isSelected && "bg-accent text-accent-foreground"
        )}
        aria-pressed={isSelected}
        onClick={() => onSelect(document.id, document.folderId)}
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
            variant={document.status === "FAILED" ? "destructive" : "secondary"}
          >
            {documentStatusLabels[document.status]}
          </Badge>
        )}
      </Button>
      <KnowledgeItemMenu
        item={{ kind: "document", id: document.id, name: document.title }}
        onAction={onAction}
      />
    </div>
  )
}
