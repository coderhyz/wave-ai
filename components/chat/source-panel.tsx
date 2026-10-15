"use client"

import { useRef, useState } from "react"
import type { UIMessage } from "ai"
import { FileText, Globe2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-mobile"
import { getChatSources, type ChatSource } from "@/lib/chat/sources"

export function SourceList({ sources }: { sources: ChatSource[] }) {
  return sources.length ? (
    <ol className="space-y-5 p-5">
      {sources.map((source) => (
        <li key={source.id}>
          <a
            href={source.url}
            target={source.kind === "search-summary" ? "_blank" : undefined}
            rel={
              source.kind === "search-summary"
                ? "noopener noreferrer"
                : undefined
            }
            className="group block space-y-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {source.kind === "search-summary" ? (
                <Globe2 className="size-3.5 shrink-0" />
              ) : (
                <FileText className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{source.domain}</span>
              <span className="ml-auto shrink-0 text-[10px]">
                {source.kind === "search-summary" ? "搜索摘要" : "文档片段"}
              </span>
            </div>
            <p className="line-clamp-2 text-sm leading-5 font-medium group-hover:text-primary">
              {source.title}
            </p>
            {source.snippet && (
              <p className="line-clamp-4 text-xs leading-5 text-muted-foreground">
                {source.snippet}
              </p>
            )}
            {source.publishedAt && (
              <p className="text-[11px] text-muted-foreground">
                {source.publishedAt}
              </p>
            )}
          </a>
        </li>
      ))}
    </ol>
  ) : (
    <p className="p-5 text-sm text-muted-foreground">本次检索尚未取得来源。</p>
  )
}

export function SourcePanel({
  message,
  onClose,
}: {
  message?: UIMessage
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const [width, setWidth] = useState(360)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const sources = getChatSources(message)
  const clampWidth = (next: number) => Math.min(560, Math.max(280, next))

  if (isMobile) {
    return (
      <Sheet
        open={!!message}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <SheetContent className="w-[90vw] gap-0">
          <SheetHeader className="border-b">
            <SheetTitle>来源 · {sources.length}</SheetTitle>
            <SheetDescription className="sr-only">
              本次回复的网页摘要和文档片段
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <SourceList sources={sources} />
          </ScrollArea>
        </SheetContent>
      </Sheet>
    )
  }
  if (!message) return null
  return (
    <aside
      aria-label="来源面板"
      className="relative z-10 flex min-h-0 shrink-0 flex-col border-l border-border/70 bg-background/95"
      style={{ width, maxWidth: "50%" }}
    >
      <div
        role="separator"
        aria-label="调整来源面板宽度"
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={560}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none hover:bg-primary/10 focus-visible:bg-primary/20"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          drag.current = { x: event.clientX, width }
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setWidth(
              clampWidth(drag.current.width + drag.current.x - event.clientX)
            )
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => {
          drag.current = null
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault()
            setWidth((previous) =>
              clampWidth(previous + (event.key === "ArrowLeft" ? 20 : -20))
            )
          }
        }}
      />
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 px-5">
        <h2 className="text-sm font-medium">
          来源{" "}
          <span className="ml-1 text-xs text-muted-foreground">
            {sources.length}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="收起来源面板"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <SourceList sources={sources} />
      </ScrollArea>
    </aside>
  )
}
