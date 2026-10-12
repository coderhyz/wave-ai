"use client"

import { useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 创建与重命名共用名称表单；失败保留输入，提交期间不能关闭。 */
export function KnowledgeNameDialog({
  title,
  description,
  pending,
  error,
  onClose,
  onSubmit,
  defaultName = "",
  maxLength = 100,
  submitLabel = "创建",
}: {
  title: string
  description: string
  pending: boolean
  error?: string
  onClose: () => void
  onSubmit: (name: string) => void
  defaultName?: string
  maxLength?: number
  submitLabel?: string
}) {
  const [name, setName] = useState(defaultName)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(name.trim())
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="knowledge-name" className="text-sm">
              名称
            </label>
            <Input
              id="knowledge-name"
              autoFocus
              required
              maxLength={maxLength}
              disabled={pending}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="输入名称"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <LoaderCircle className="animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
