"use client"

import { isToolUIPart, getToolName, type UIMessage } from "ai"
import {
  ChevronDown,
  FileText,
  ListChecks,
  LoaderCircle,
  PanelRightOpen,
  Search,
} from "lucide-react"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

const querySchema = z.object({ query: z.string() })
const outputSchema = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  results: z.array(z.unknown()).optional(),
  items: z.array(z.unknown()).optional(),
})

export function SearchActivity({
  message,
  isStreaming,
  sourceCount,
  onShowSources,
}: {
  message: UIMessage
  isStreaming: boolean
  sourceCount: number
  onShowSources?: () => void
}) {
  const currentStep = message.parts.findLastIndex(
    (part) => part.type === "step-start"
  )
  const searches = message.parts.flatMap((part, index) => {
    if (
      !isToolUIPart(part) ||
      !["webSearch", "searchKnowledge"].includes(getToolName(part))
    )
      return []
    // SDK 的静态工具参数校验失败时，原始参数保存在 rawInput。
    const input = querySchema.safeParse(
      part.input ??
        (part.state === "output-error" && "rawInput" in part
          ? part.rawInput
          : undefined)
    )
    const output =
      part.state === "output-available"
        ? outputSchema.safeParse(part.output)
        : undefined
    const result = output?.success ? output.data : undefined
    const failed = part.state === "output-error" || result?.success === false
    const done =
      part.state === "output-available" && !part.preliminary && !failed
    const count = (result?.results ?? result?.items)?.length ?? 0
    const active =
      isStreaming &&
      index > currentStep &&
      !done &&
      !failed &&
      part.state !== "output-denied"
    return [
      {
        id: part.toolCallId,
        knowledge: getToolName(part) === "searchKnowledge",
        query: input.success
          ? input.data.query
          : failed
            ? "工具调用未完成"
            : "整理检索条件",
        active,
        failed,
        label:
          result?.errorCode === "TIME_BUDGET_EXCEEDED"
            ? "研究时间已用尽"
            : result?.errorCode === "BUDGET_EXCEEDED"
              ? "已达调用上限"
              : part.state === "output-error"
                ? "工具调用失败"
                : failed
                  ? "检索失败"
                  : done
                    ? count
                      ? `${count} 条结果`
                      : "未找到结果"
                    : part.state === "output-denied"
                      ? "已取消"
                      : active
                        ? "检索中"
                        : "未完成",
        error:
          part.state === "output-error"
            ? part.errorText === "An error occurred."
              ? "未收到具体错误原因，请重新发起研究。"
              : part.errorText
            : result?.error,
      },
    ]
  })
  if (message.role !== "assistant" || searches.length === 0) return null
  const active = searches.some((search) => search.active)
  return (
    <Collapsible defaultOpen className="mb-4 text-sm">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="group -ml-2 text-muted-foreground"
          >
            {active ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ListChecks className="size-4" />
            )}
            {active ? "正在检索" : "检索记录"}
            <span className="text-xs tabular-nums">{searches.length} 次</span>
            <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        {sourceCount > 0 && onShowSources && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onShowSources}
            aria-label={`查看 ${sourceCount} 个来源`}
          >
            <PanelRightOpen className="size-3.5" />
            来源 {sourceCount}
          </Button>
        )}
      </div>
      <CollapsibleContent className="pt-2">
        <ol className="ml-2 space-y-3 border-l border-border/70 pl-4">
          {searches.map((search) => (
            <li key={search.id} className="space-y-1" role="status">
              <div className="flex items-start gap-2 text-muted-foreground">
                {search.knowledge ? (
                  <FileText className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <Search className="mt-0.5 size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 break-words">
                  {search.query}
                </span>
                <span
                  className={
                    search.failed
                      ? "shrink-0 text-xs text-destructive"
                      : "shrink-0 text-xs"
                  }
                >
                  {search.label}
                </span>
              </div>
              {search.failed && search.error && (
                <p className="line-clamp-2 pl-5.5 text-xs text-destructive">
                  {search.error}
                </p>
              )}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
