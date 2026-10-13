"use client"

import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { TreeItem } from "./knowledge-item-menu"

/** 删除范围必须明确展示；这里只负责确认，真正的删除由父组件执行。 */
export function KnowledgeDeleteDialog({
  open,
  item,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean
  item?: TreeItem
  pending: boolean
  error?: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {item?.kind === "base"
              ? "删除整个知识库？"
              : item?.kind === "folder"
                ? "删除目录及其文件？"
                : "删除文件？"}
          </DialogTitle>
          <DialogDescription>
            {item?.kind === "base"
              ? `将删除知识库「${item.name}」及其中所有目录、文件。`
              : item?.kind === "folder"
                ? `将删除目录「${item.name}」及全部子目录和文件。`
                : `将删除文件「${item?.name}」。`}
            此操作不可撤销，原件和解析图片将彻底删除。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending && <LoaderCircle className="animate-spin" />}
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
