"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Copy, LoaderCircle, Save } from "lucide-react"
import { toast } from "sonner"
import {
  KnowledgeRequestError,
  useSaveKnowledgeDocumentContent,
  type KnowledgeDocument,
} from "@/hooks/use-knowledge"
import type { SaveKnowledgeDocumentContentInput } from "@/lib/knowledge/schemas"
import { MAX_MARKDOWN_CHARACTERS } from "@/lib/knowledge/parsers/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { KnowledgeMarkdown } from "./knowledge-markdown"

// baseContent 是当前草稿的比较基准；版本号用于服务端并发校验，不能以标题 revision 代替。
type DocumentDraft = SaveKnowledgeDocumentContentInput & { baseContent: string }

/** 保存过程中还能输入；只清除已提交的草稿，新输入必须接着使用服务器返回的版本。 */
export function reconcileSavedDraft(
  draft: DocumentDraft | null,
  submitted: SaveKnowledgeDocumentContentInput,
  saved: Pick<KnowledgeDocument, "markdownContent" | "contentRevision">
): DocumentDraft | null {
  if (
    !draft ||
    draft.markdownContent === submitted.markdownContent ||
    draft.markdownContent === saved.markdownContent
  )
    return null
  return {
    ...draft,
    baseContent: saved.markdownContent ?? "",
    expectedContentRevision: saved.contentRevision,
  }
}

/** 三种显示模式共用一份本地草稿；Query 缓存只保存已经落库的正文。 */
export function DocumentEditor({
  document,
  reloading,
  onReload,
  onLeaveGuardChange,
}: {
  document: KnowledgeDocument
  reloading: boolean
  onReload: () => Promise<void>
  onLeaveGuardChange?: (guard: () => boolean) => void
}) {
  const [mode, setMode] = useState<"read" | "edit" | "split">("read")
  const [draft, setDraft] = useState<DocumentDraft | null>(null)
  const [autoSave, setAutoSave] = useState(false)
  const saving = useSaveKnowledgeDocumentContent(document.id)
  const { mutate } = saving
  // 互斥锁防止自动保存与快捷键在同一渲染周期内同时提交，不作为另一份界面状态。
  const inFlight = useRef(false)
  const content = draft?.markdownContent ?? document.markdownContent ?? ""
  // dirty 以草稿基准比较；后台刷新 Query 不能改变本地输入或掩盖未保存修改。
  const dirty = draft !== null && draft.markdownContent !== draft.baseContent
  const conflict =
    saving.error instanceof KnowledgeRequestError && saving.error.status === 409

  const save = useCallback(() => {
    if (!draft || !dirty || inFlight.current || reloading || conflict) return
    inFlight.current = true
    mutate(
      {
        markdownContent: draft.markdownContent,
        expectedContentRevision: draft.expectedContentRevision,
      },
      {
        onSuccess: (data, submitted) =>
          setDraft((current) =>
            reconcileSavedDraft(current, submitted, data.document)
          ),
        onSettled: () => {
          inFlight.current = false
        },
      }
    )
  }, [draft, dirty, reloading, conflict, mutate])

  // 自动保存仅由用户开启；错误后停止，避免版本冲突或断网时重复提交。
  useEffect(() => {
    if (!autoSave || !dirty || saving.isPending || saving.isError || reloading)
      return
    const timer = window.setTimeout(save, 1200)
    return () => window.clearTimeout(timer)
  }, [autoSave, dirty, saving.isPending, saving.isError, reloading, save])

  // 快捷键支持 Windows/Linux 的 Ctrl+S 和 macOS 的 Cmd+S。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [save])

  // 父页面在切换文档/知识库前调用此守卫；刷新或关闭页面由浏览器提示。
  useEffect(() => {
    const unsaved = dirty || saving.isPending
    onLeaveGuardChange?.(() => {
      if (saving.isPending || inFlight.current) {
        toast.error("请等待正文保存完成后再操作")
        return false
      }
      return !dirty || window.confirm("正文尚未保存，确定离开并放弃草稿吗？")
    })
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsaved) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      onLeaveGuardChange?.(() => true)
    }
  }, [dirty, saving.isPending, onLeaveGuardChange])

  async function reload() {
    if (
      dirty &&
      !window.confirm("重新加载会放弃当前草稿，是否继续？建议先复制本地内容。")
    )
      return
    try {
      await onReload()
      setDraft(null)
      saving.reset()
    } catch (error) {
      // 读取失败不清草稿，也不解除冲突锁定。
      toast.error(error instanceof Error ? error.message : "重新加载失败")
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(content)
      toast.success("本地内容已复制")
    } catch {
      toast.error("复制失败，请在编辑框中手动选中并复制")
    }
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3"
      aria-label="Markdown 编辑与保存"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="文档显示模式">
          {(["read", "edit", "split"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {{ read: "阅读", edit: "编辑", split: "分屏" }[value]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(event) => setAutoSave(event.target.checked)}
            />
            自动保存
          </label>
          <span role="status" className="text-xs text-muted-foreground">
            {saving.isPending
              ? "保存中…"
              : dirty
                ? "有未保存修改"
                : saving.isSuccess
                  ? "已保存"
                  : "无未保存修改"}
          </span>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || saving.isPending || reloading || conflict}
          >
            {saving.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Save />
            )}
            保存
          </Button>
        </div>
      </div>
      {saving.isError && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p className="text-destructive">{saving.error.message}</p>
          <p className="text-muted-foreground">
            {conflict
              ? "本地草稿已保留，请复制后重新加载最新正文，再合并修改。"
              : "草稿已保留，自动保存已暂停，请手动重试。"}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={copyDraft}>
              <Copy />
              复制本地内容
            </Button>
            {conflict ? (
              <Button
                size="sm"
                variant="outline"
                disabled={reloading}
                onClick={reload}
              >
                重新加载正文
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={saving.isPending || reloading}
                onClick={save}
              >
                重试保存
              </Button>
            )}
          </div>
        </div>
      )}
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4",
          mode === "split" && "md:grid-cols-2"
        )}
      >
        {mode !== "read" && (
          <Textarea
            aria-label="Markdown 正文"
            value={content}
            maxLength={MAX_MARKDOWN_CHARACTERS}
            disabled={reloading}
            spellCheck={false}
            className="[field-sizing:fixed] h-full min-h-60 resize-none overflow-auto font-mono"
            onChange={(event) => {
              const markdownContent = event.target.value
              const baseContent =
                draft?.baseContent ?? document.markdownContent ?? ""
              // 提交过程中即使用户撤回到旧正文，也保留该输入，不能被迟到的保存结果抹掉。
              setDraft(
                markdownContent === baseContent && !inFlight.current
                  ? null
                  : {
                      markdownContent,
                      baseContent,
                      expectedContentRevision:
                        draft?.expectedContentRevision ??
                        document.contentRevision,
                    }
              )
            }}
          />
        )}
        {mode !== "edit" && (
          <div className="min-h-0 min-w-0 overflow-auto">
            {content ? (
              <KnowledgeMarkdown documentId={document.id} content={content} />
            ) : (
              <p className="text-sm text-muted-foreground">
                正文为空，可切换到编辑模式填写。
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
