"use client"

import type { ComponentProps } from "react"
import { MessageResponse } from "@/components/ai-elements/message"
import { ArrowUpRight, Globe2 } from "lucide-react"
import {
  getKnowledgeCitationHref,
  type getKnowledgeCitations,
} from "@/lib/chat/citations"

const referenceComponents = {
  ul: ({ children }: ComponentProps<"ul">) => (
    <ul className="contents">{children}</ul>
  ),
  ol: ({ children }: ComponentProps<"ol">) => (
    <ol className="contents">{children}</ol>
  ),
  li: ({ children }: ComponentProps<"li">) => (
    <li className="group inline-flex max-w-full min-w-0 list-none items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-primary/30 hover:bg-muted/60">
      <Globe2
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="flex min-w-0 items-center gap-1.5 [&>p]:contents">
        {children}
      </div>
      <ArrowUpRight
        className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary"
        aria-hidden="true"
      />
    </li>
  ),
  p: ({ children }: ComponentProps<"p">) => (
    <p className="m-0 min-w-0">{children}</p>
  ),
}

/** 参考资料仅改变展示布局，原始 Markdown 仍用于复制、导出和保存。 */
export function ChatMessageResponse({
  children,
  citations = [],
}: {
  children: string
  citations?: ReturnType<typeof getKnowledgeCitations>
}) {
  // 忽略代码示例中的同名标题，只处理回答末尾的参考资料章节。
  const sections = Array.from(
    children.matchAll(
      /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|^(?:#{1,6}[ \t]+)?(?:\*\*)?(参考资料|来源列表|引用来源)(?:\*\*)?[ \t]*[:：]?[ \t]*(?:\*\*)?[ \t]*\r?$/gm
    )
  )
  const section = sections.findLast((match) => match[1])
  if (!section) return <MessageResponse>{children}</MessageResponse>

  const references = children.slice(section.index + section[0].length).trim()
  if (!references) return <MessageResponse>{children}</MessageResponse>

  // 正文中的 [S1] 等引用仍需使用末尾的 Markdown 链接定义。
  const definitions: string[] =
    references.match(/^ {0,3}\[S\d+\]:[^\r\n]+/gm) ?? []
  const definedLabels = new Set(
    definitions.map((definition) =>
      definition.slice(0, definition.indexOf(":")).trim()
    )
  )
  const body = children.slice(0, section.index).trimEnd()
  const citationHrefs = new Set(citations.map(getKnowledgeCitationHref))
  // 已登记文档由 KnowledgeCitations 展示；正文引用定义和网页来源继续保留。
  const visibleReferences = references
    .replace(
      /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|^ {0,3}(?:(?:[-*+]|\d+\.)[ \t]+)?(?:(\[S\d+\])[ \t]+)?\[(?:\\.|[^\]\\\n])*\]\((\/home\?[^)\n]+)\)[ \t]*\r?$/gm,
      (line, label: string | undefined, href: string | undefined) => {
        if (!href || !citationHrefs.has(href)) return line
        if (label && !definedLabels.has(label)) {
          definitions.push(`${label}: ${href}`)
          definedLabels.add(label)
        }
        return ""
      }
    )
    .replace(/^ {0,3}\[S\d+\]:[^\r\n]+/gm, "")
    .trim()

  return (
    <>
      <MessageResponse mode="static">
        {body + "\n\n" + definitions.join("\n")}
      </MessageResponse>
      {visibleReferences && (
        <section
          aria-label={section[1]}
          className="mt-4 max-w-full min-w-0 border-t border-border/50 pt-3"
        >
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {section[1]}
          </h3>
          <MessageResponse
            mode="static"
            className="flex h-auto flex-wrap gap-2 space-y-0 [&_[data-streamdown=link]]:block [&_[data-streamdown=link]]:max-w-64 [&_[data-streamdown=link]]:min-w-0 [&_[data-streamdown=link]]:truncate [&_[data-streamdown=link]]:text-sm [&_[data-streamdown=link]]:font-medium [&_[data-streamdown=link]]:text-foreground [&_[data-streamdown=link]]:no-underline [&_[data-streamdown=link]:focus-visible]:outline [&_[data-streamdown=link]:focus-visible]:outline-ring [&_[data-streamdown=link]:hover]:text-primary"
            components={referenceComponents}
          >
            {visibleReferences.replace(/^\[S\d+\][ \t]+/gm, "- $&") +
              "\n\n" +
              definitions.join("\n")}
          </MessageResponse>
        </section>
      )}
    </>
  )
}
