"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Download, LoaderCircle, RefreshCw, X } from "lucide-react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  useKnowledgeFilePreview,
  downloadKnowledgeDocumentOriginal,
} from "@/hooks/use-knowledge"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

const BinaryFilePreview = dynamic(() => import("./binary-file-preview"), {
  ssr: false,
  loading: () => (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      正在加载文档阅读器…
    </p>
  ),
})

/** 不执行原始 HTML，也不加载 Markdown 内的外部追踪图片。 */
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

/** 统一原件预览；加载和刷新来自 Query，下载复用既有鉴权下载接口。 */
export function FilePreview({
  documentId,
  onClose,
  showFileInfo = true,
}: {
  documentId: string
  onClose?: () => void
  showFileInfo?: boolean
}) {
  const query = useKnowledgeFilePreview(documentId)
  const file = query.data
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  )
  const download = useMutation({
    mutationFn: (filename: string) =>
      downloadKnowledgeDocumentOriginal(documentId, filename),
    retry: false,
    onError: (error) => toast.error(error.message),
  })
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3"
      aria-label="原件预览"
    >
      <header className="flex flex-wrap items-center justify-end gap-2 border-b pb-3">
        {showFileInfo && (
          <h2
            className="min-w-0 flex-1 truncate font-semibold"
            title={file?.fileName}
          >
            {file?.fileName ?? "原文件预览"}
          </h2>
        )}
        {showFileInfo && file && (
          <Badge variant="outline">
            {file.fileName.split(".").at(-1)?.toUpperCase()}
          </Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => {
            setImageStatus("loading")
            query.refetch()
          }}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : ""} />
          刷新预览
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!file || download.isPending}
          onClick={() => {
            if (file) download.mutate(file.fileName)
          }}
        >
          <Download />
          下载原件
        </Button>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
        {query.isPending || query.isFetching ? (
          <p
            role="status"
            className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
          >
            <LoaderCircle className="size-4 animate-spin" />
            正在读取原文件…
          </p>
        ) : query.isError ? (
          <div role="alert" className="space-y-2 p-6 text-sm">
            <p className="text-destructive">{query.error.message}</p>
            <p>原件加载失败，请刷新预览；持续失败时请检查 OSS 跨域配置。</p>
          </div>
        ) : (
          file && (
            <>
              {(file.kind === "pdf" || file.kind === "docx") && (
                <BinaryFilePreview
                  key={file.url}
                  url={file.url}
                  fileName={file.fileName}
                  kind={file.kind}
                  fileData={file.fileData}
                />
              )}
              {file.kind === "markdown" && (
                <div className="space-y-4 p-5 break-words [&_code]:font-mono [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6">
                  <OriginalMarkdown content={file.text ?? ""} />
                </div>
              )}
              {file.kind === "text" && (
                <pre className="overflow-auto p-5 font-mono text-sm whitespace-pre">
                  {file.text}
                </pre>
              )}
              {file.kind === "image" &&
                (imageStatus === "error" ? (
                  <p role="alert" className="p-6 text-sm text-destructive">
                    图片加载失败或链接已过期，请刷新预览。
                  </p>
                ) : (
                  <>
                    {imageStatus === "loading" && (
                      <p
                        role="status"
                        className="p-6 text-sm text-muted-foreground"
                      >
                        正在加载图片…
                      </p>
                    )}
                    {/* 图片直接交给浏览器，不经 Next Image 代理或额外上传。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={file.url}
                      alt={file.fileName}
                      onLoad={() => setImageStatus("ready")}
                      onError={() => setImageStatus("error")}
                      className="mx-auto max-h-full max-w-full object-contain"
                    />
                  </>
                ))}
              {file.kind === "unsupported" && (
                <p className="p-6 text-sm text-muted-foreground">
                  暂不支持此类型在线预览，请点击“下载原件”后打开。
                </p>
              )}
            </>
          )
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        这里显示 OSS 原件，不受解析状态或正文编辑影响。临时链接有效期为 15
        分钟，加载失败或过期时请刷新预览。
      </p>
    </section>
  )
}
