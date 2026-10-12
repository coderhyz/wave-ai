"use client"

import { useMemo } from "react"
import { useTheme } from "next-themes"
import DocViewer, {
  PDFRenderer,
  DocxRenderer,
} from "@iamjariwala/react-doc-viewer"
import "@iamjariwala/react-doc-viewer/dist/index.css"

// 只启用当前需要的两种渲染器，不加载其他格式或在线 Office 服务。
const renderers = [PDFRenderer, DocxRenderer]

/** 此模块仅由 next/dynamic 在浏览器加载；DOCX 本地渲染，不发送到 Office Online。 */
export default function BinaryFilePreview({
  url,
  fileName,
  kind,
  fileData,
}: {
  url: string
  fileName: string
  kind: "pdf" | "docx"
  fileData: ArrayBuffer
}) {
  const { resolvedTheme } = useTheme()
  // 阅读器监视 documents 的引用，避免主题/父组件渲染触发重复下载。
  const documents = useMemo(
    // 已下载的字节直接交给阅读器，避免它再次请求 OSS 或吞掉下载错误。
    () => [{ uri: url, fileName, fileType: kind, fileData }],
    [url, fileName, kind, fileData]
  )
  return (
    <DocViewer
      documents={documents}
      pluginRenderers={renderers}
      config={{
        header: { disableHeader: true },
        themeMode: resolvedTheme === "dark" ? "dark" : "light",
        docx: { useOfficeOnlineViewer: false },
      }}
      className="h-full min-h-0 w-full"
      style={{ height: "100%" }}
    />
  )
}
