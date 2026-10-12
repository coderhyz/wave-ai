"use client"

import { useCallback, useRef, useState } from "react"
import { parseAsString, useQueryStates } from "nuqs"
import { BookOpen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  useCreateKnowledgeBase,
  useKnowledgeBases,
  useUploadKnowledgeDocument,
} from "@/hooks/use-knowledge"
import { KnowledgeBaseWorkspace } from "./knowledge-base-workspace"
import { KnowledgeNameDialog } from "../knowledge-name-dialog"

/** 工作区入口只协调知识库与 URL 选择；切换前调用编辑器注册的草稿守卫。 */
export function KnowledgeWorkspace() {
  const [selection, setSelection] = useQueryStates({
    base: parseAsString.withDefault(""),
    folder: parseAsString.withDefault(""),
    document: parseAsString.withDefault(""),
  })
  const bases = useKnowledgeBases()
  const createBase = useCreateKnowledgeBase()
  const [creatingBase, setCreatingBase] = useState(false)
  const leaveDocument = useRef<() => boolean>(() => true)
  // 传给编辑器 Effect 的注册函数保持稳定，避免无关渲染反复注销守卫。
  const registerLeaveGuard = useCallback((guard: () => boolean) => {
    leaveDocument.current = guard
  }, [])
  // 默认知识库直接从列表推导，不额外用 Effect 同步一份远端状态。
  const knowledgeBaseId = selection.base || bases.data?.items[0]?.id || ""
  // 父级也需要禁用切库按钮，直接复用上传 Mutation 的状态，不维护第二份 busy。
  const upload = useUploadKnowledgeDocument(knowledgeBaseId)
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <BookOpen className="size-5" />
            知识库
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            上传文件即可预览原件，解析后可编辑 Markdown 正文。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={knowledgeBaseId}
            disabled={bases.isPending || upload.isPending}
            onValueChange={(base) => {
              if (!leaveDocument.current()) return
              upload.reset()
              setSelection({ base, folder: "", document: "" })
            }}
          >
            <SelectTrigger aria-label="选择知识库" className="w-48">
              <SelectValue placeholder="选择知识库" />
            </SelectTrigger>
            <SelectContent>
              {bases.data?.items.map((base) => (
                <SelectItem key={base.id} value={base.id}>
                  {base.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={upload.isPending}
            onClick={() => {
              createBase.reset()
              setCreatingBase(true)
            }}
          >
            <Plus />
            新建知识库
          </Button>
        </div>
      </div>
      {bases.isPending && (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          正在加载知识库…
        </p>
      )}
      {bases.isError && (
        <div role="alert" className="space-y-3 p-6">
          <p className="text-sm text-destructive">{bases.error.message}</p>
          <Button variant="outline" onClick={() => bases.refetch()}>
            重新加载
          </Button>
        </div>
      )}
      {bases.isSuccess && !knowledgeBaseId && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
          <BookOpen className="size-10 text-muted-foreground" />
          <h2 className="font-medium">创建你的第一个知识库</h2>
          <p className="text-sm text-muted-foreground">
            按主题整理文件，上传后即可预览原件。
          </p>
        </div>
      )}
      {bases.data && knowledgeBaseId && (
        <KnowledgeBaseWorkspace
          key={knowledgeBaseId}
          knowledgeBaseId={knowledgeBaseId}
          folderId={selection.folder || null}
          documentId={selection.document}
          onSelect={(folder, document) => {
            if (document !== selection.document && !leaveDocument.current())
              return false
            setSelection({
              base: knowledgeBaseId,
              folder: folder ?? "",
              document,
            })
            return true
          }}
          onLeaveGuardChange={registerLeaveGuard}
          // 删除前已确认草稿，成功后直接清空选择，不再次触发离开提示。
          onDeleted={() => setSelection({ document: "" })}
          onSelectionDeleted={(clearFolder) =>
            setSelection({
              document: "",
              ...(clearFolder ? { folder: "" } : {}),
            })
          }
          onKnowledgeBaseDeleted={() =>
            setSelection({ base: "", folder: "", document: "" })
          }
          canLeaveDocument={() => leaveDocument.current()}
          upload={upload}
        />
      )}
      {creatingBase && (
        <KnowledgeNameDialog
          title="新建知识库"
          description="知识库仅对当前账户可见。"
          pending={createBase.isPending}
          error={createBase.error?.message}
          onClose={() => setCreatingBase(false)}
          onSubmit={(name) =>
            createBase.mutate(name, {
              onSuccess: ({ knowledgeBase }) => {
                if (leaveDocument.current())
                  setSelection({
                    base: knowledgeBase.id,
                    folder: "",
                    document: "",
                  })
                setCreatingBase(false)
              },
            })
          }
        />
      )}
    </section>
  )
}
