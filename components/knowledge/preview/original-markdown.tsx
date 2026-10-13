"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** OSS 中的原始 MD 使用 GFM 渲染；不执行 HTML，也不加载外部追踪图片。 */
export function OriginalMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            {children}
          </a>
        ),
        img: ({ alt }) => (
          <span className="text-muted-foreground">
            [图片未加载{alt ? `：${alt}` : ""}]
          </span>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
