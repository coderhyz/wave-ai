"use client"

import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
} from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import {
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import { CodeBlock } from "streamdown"

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  bash: "sh",
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  javascript: "js",
  js: "js",
  json: "json",
  jsx: "jsx",
  markdown: "md",
  md: "md",
  php: "php",
  plaintext: "txt",
  python: "py",
  py: "py",
  rust: "rs",
  shell: "sh",
  sql: "sql",
  text: "txt",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yml",
}

const getTextContent = (children: ReactNode): string => {
  if (typeof children === "string" || typeof children === "number") {
    return String(children)
  }

  if (Array.isArray(children)) {
    return children.map(getTextContent).join("")
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return getTextContent(children.props.children)
  }

  return ""
}

/**
 * 兼容非 HTTPS 环境的复制方法。
 * Clipboard API 不可用时，回退到隐藏 textarea 的传统复制方案。
 */
const writeClipboard = async (text: string) => {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  try {
    if (!document.execCommand("copy")) {
      throw new Error("浏览器拒绝了复制操作")
    }
  } finally {
    textarea.remove()
  }
}

function CodeBlockActions({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  const handleCopy = useCallback(async () => {
    try {
      await writeClipboard(code)
      setCopied(true)
      toast.success("代码已复制")
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error("复制代码失败：", error)
      toast.error("复制失败，请检查浏览器剪贴板权限")
    }
  }, [code])

  const handleDownload = useCallback(() => {
    try {
      const normalizedLanguage = language.trim().toLowerCase()
      const safeLanguage = normalizedLanguage.replace(/[^a-z0-9_-]/g, "")
      const extension =
        LANGUAGE_EXTENSIONS[normalizedLanguage] || safeLanguage || "txt"
      const blob = new Blob([code], { type: "text/plain;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")

      link.href = url
      link.download = `code-snippet.${extension}`
      document.body.appendChild(link)
      link.click()
      link.remove()

      // 延迟释放，避免部分浏览器还未读取 Blob 就失效。
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success("代码文件已下载")
    } catch (error) {
      console.error("下载代码失败：", error)
      toast.error("代码下载失败")
    }
  }, [code, language])

  const buttonClassName =
    "cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <>
      <button
        aria-label="下载代码"
        className={buttonClassName}
        onClick={handleDownload}
        title="下载代码"
        type="button"
      >
        <DownloadIcon aria-hidden="true" className="size-4" />
      </button>
      <button
        aria-label={copied ? "代码已复制" : "复制代码"}
        className={buttonClassName}
        onClick={handleCopy}
        title={copied ? "代码已复制" : "复制代码"}
        type="button"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-4 text-emerald-500" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-4" />
        )}
      </button>
    </>
  )
}

type MessageCodeBlockProps = ComponentProps<"code"> & {
  node?: unknown
  "data-block"?: boolean | string
}

/** Streamdown 的代码渲染器：行内代码保持原样，代码块使用可靠的复制和下载控件。 */
export function MessageCodeBlock({
  children,
  className,
  node: _node,
  ...props
}: MessageCodeBlockProps) {
  void _node
  const isBlock = "data-block" in props

  if (!isBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }

  const language = className?.match(/language-([^\s]+)/)?.[1] ?? "text"
  const code = getTextContent(children).replace(/\n$/, "")

  return (
    <CodeBlock code={code} language={language}>
      <CodeBlockActions code={code} language={language} />
    </CodeBlock>
  )
}
