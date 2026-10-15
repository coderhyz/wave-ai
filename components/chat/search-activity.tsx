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
  const searchParts = message.parts.flatMap((part, index) =>
    isToolUIPart(part) &&
    ["webSearch", "searchKnowledge"].includes(getToolName(part))
      ? [{ part, index }]
      : []
  )
  const searches = searchParts.flatMap(({ part, index }) => {
    const output =
      part.state === "output-available"
        ? outputSchema.safeParse(part.output)
        : undefined
    const result = output?.success ? output.data : undefined
    if (part.state === "output-error" || result?.success === false) return []
    const input = querySchema.safeParse(part.input)
    const done = part.state === "output-available" && !part.preliminary
    const count = (result?.results ?? result?.items)?.length ?? 0
    const active =
      isStreaming &&
      index > currentStep &&
      !done &&
      part.state !== "output-denied"
    return [
      {
        id: part.toolCallId,
        knowledge: getToolName(part) === "searchKnowledge",
        query: input.success ? input.data.query : "整理检索条件",
        active,
        label: done
          ? count
            ? `${count} 条结果`
            : "未找到结果"
          : part.state === "output-denied"
            ? "已取消"
            : active
              ? "检索中"
              : "未完成",
      },
    ]
  })
  if (
    message.role !== "assistant" ||
    searchParts.length === 0 ||
    (searches.length === 0 && (!sourceCount || !onShowSources))
  )
    return null
  const active = searches.some((search) => search.active)
  return (
    <Collapsible defaultOpen className="mb-4 text-sm">
      <div className="flex items-center gap-2">
        {searches.length > 0 && (
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
        )}
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
      {searches.length > 0 && (
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
                  <span className="shrink-0 text-xs">{search.label}</span>
                </div>
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
