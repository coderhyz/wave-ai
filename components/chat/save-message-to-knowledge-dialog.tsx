"use client"

import { useId, useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { toast } from "sonner"
import {
  useKnowledgeBases,
  useUploadKnowledgeDocument,
} from "@/hooks/use-knowledge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function SaveMessageToKnowledgeDialog({
  content,
  onClose,
}: {
  content: string
  onClose: () => void
}) {
  const id = useId()
  const bases = useKnowledgeBases()
  const [selectedBaseId, setSelectedBaseId] = useState("")
  // 初始标题为正文首行
  const [title, setTitle] = useState(
    () =>
      content
        .trim()
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .slice(0, 80) || "AI 回复"
  )
  const knowledgeBaseId = selectedBaseId || bases.data?.items[0]?.id || ""
  const upload = useUploadKnowledgeDocument(knowledgeBaseId)

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim() || !knowledgeBaseId || upload.isPending) return
    const filename = title.trim().replace(/[\\/:*?"<>|]/g, "-") + ".md"
    upload.mutate(
      {
        file: new File([content.trim()], filename, { type: "text/markdown" }),
        folderId: null,
      },
      {
        onSuccess: () => {
          toast.success("已保存到知识库")
          onClose()
        },
      }
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !upload.isPending) onClose()
      }}
    >
      <DialogContent showCloseButton={!upload.isPending}>
        <DialogHeader>
          <DialogTitle>保存到知识库</DialogTitle>
          <DialogDescription>
            将回复正文及来源保存为文档，存放到所选知识库的根目录。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor={id + "-base"} className="text-sm">
              知识库
            </label>
            <Select
              value={knowledgeBaseId}
              disabled={
                bases.isPending ||
                bases.isError ||
                !knowledgeBaseId ||
                upload.isPending
              }
              onValueChange={(value) => {
                setSelectedBaseId(value)
                upload.reset()
              }}
            >
              <SelectTrigger id={id + "-base"} className="w-full">
                <SelectValue
                  placeholder={
                    bases.isPending ? "正在加载知识库…" : "选择知识库"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {bases.data?.items.map((base) => (
                  <SelectItem key={base.id} value={base.id}>
                    {base.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label htmlFor={id + "-title"} className="text-sm">
              文档标题
            </label>
            <Input
              id={id + "-title"}
              autoFocus
              required
              maxLength={100}
              value={title}
              disabled={upload.isPending}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          {bases.isSuccess && !bases.data.items.length && (
            <p role="status" className="text-sm text-muted-foreground">
              暂无知识库，请先在知识库页面创建。
            </p>
          )}
          {bases.isError && (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">{bases.error.message}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => bases.refetch()}
              >
                重新加载
              </Button>
            </div>
          )}
          {upload.isError && (
            <p role="alert" className="text-sm text-destructive">
              {upload.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={upload.isPending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                !knowledgeBaseId ||
                !title.trim() ||
                bases.isError ||
                upload.isPending
              }
            >
              {upload.isPending && <LoaderCircle className="animate-spin" />}
              {upload.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
