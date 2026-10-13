"use client"

import type { UIMessage } from "ai"
import Link from "next/link"
import { ArrowUpRight, FileText } from "lucide-react"
import {
  getKnowledgeCitations,
  getKnowledgeCitationHref,
} from "@/lib/chat/citations"

/** 同一文档的多个检索命中只显示一个来源。 */
export function KnowledgeCitations({ message }: { message: UIMessage }) {
  const citations = Array.from(
    new Map(
      getKnowledgeCitations(message).map((citation) => [
        citation.documentId,
        citation,
      ])
    ).values()
  )
  if (!citations.length) return null
  return (
    <section
      aria-label="回答引用"
      className="mt-4 border-t border-border/50 pt-3"
    >
      <p className="mb-2 text-xs font-medium text-muted-foreground">参考文档</p>
      <div className="flex flex-wrap gap-2">
        {citations.map((citation) => (
          <Link
            key={citation.documentId}
            href={getKnowledgeCitationHref(citation)}
            prefetch={false}
            title={"打开文档：" + citation.documentTitle}
            className="group inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm transition-colors hover:border-primary/30 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <FileText
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="max-w-64 truncate">{citation.documentTitle}</span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>
    </section>
  )
}
