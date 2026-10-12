"use client"

import { Streamdown, type UrlTransform } from "streamdown"
import {
  getKnowledgeAssetUrl,
  isSafeKnowledgeAssetName,
} from "@/lib/knowledge/assets"
import { useStreamdownPlugins } from "@/components/ai-elements/use-streamdown-plugins"
import { MessageCodeBlock } from "@/components/ai-elements/code-block-controls"

/** 原始 HTML 不执行，图片仅允许当前文档的鉴权资源，防止外部追踪图片。 */
export function KnowledgeMarkdown({
  content,
  documentId,
}: {
  content: string
  documentId: string
}) {
  // 这里展示数据库正文，不读取 OSS 原件；解析图片只能走当前文档的鉴权资源接口。
  const plugins = useStreamdownPlugins(content)
  const urlTransform: UrlTransform = (url, key) => {
    if (key === "src") {
      const prefix = getKnowledgeAssetUrl(documentId, "")
      return url.startsWith(prefix) &&
        isSafeKnowledgeAssetName(url.slice(prefix.length))
        ? url
        : ""
    }
    return /^(https?:\/\/|mailto:|#)/i.test(url) ? url : ""
  }
  return (
    <Streamdown
      mode="static"
      plugins={plugins}
      skipHtml
      rehypePlugins={[]}
      urlTransform={urlTransform}
      controls={{ image: false }}
      components={{
        // 复用代码复制/下载控件，图表代码也只展示源码，不生成可加载外部资源的 SVG。
        code: MessageCodeBlock,
        a: ({ href, children }) =>
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        img: ({ src, alt }) =>
          typeof src === "string" && src ? (
            // 站内鉴权图片不能交给 Next Image 的服务端代理，否则会丢失用户 Cookie。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={alt ?? "解析图片"}
              loading="lazy"
              className="max-w-full rounded-md"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              [图片未加载{alt ? `：${alt}` : ""}]
            </span>
          ),
      }}
      className="min-w-0 break-words"
    >
      {content}
    </Streamdown>
  )
}
