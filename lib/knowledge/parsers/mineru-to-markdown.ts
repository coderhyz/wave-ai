/**
 * MinerU 结果到知识库统一解析结果的适配层。
 * PDF 和 DOCX 共用这里的图片转存、正文规范化和章节提取逻辑。
 */
import path from "node:path"
import type JSZip from "jszip"
import { parseWithMineru } from "@/lib/knowledge/parsers/mineru-client"
import {
  extractMarkdownSections,
  normalizeText,
} from "@/lib/knowledge/parsers/normalize"
import {
  assertMarkdownSize,
  type KnowledgeDocumentParser,
  type KnowledgeSourceKind,
  type ParseContext,
} from "@/lib/knowledge/parsers/types"

/** 当前站内资源接口允许保存的 MinerU 图片格式。 */
const imageTypes = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const

/**
 * 将 MinerU ZIP 内的相对图片上传到本站 OSS，
 * 并把 Markdown 中的相对路径替换为需要鉴权的站内 URL。
 */
async function uploadMineruImages(
  markdown: string,
  archive: JSZip,
  rootPath: string,
  context: ParseContext
) {
  context.signal?.throwIfAborted()
  if (!context.uploadAsset) return markdown

  let output = markdown
  // 去重收集 Markdown 图片语法中的目标路径。
  const imagePaths = [
    ...new Set(
      [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
    ),
  ]

  for (const imagePath of imagePaths) {
    context.signal?.throwIfAborted()
    // 图片路径相对于 full.md 所在目录解析。
    const normalizedPath = decodeURIComponent(imagePath).replace(/^\.\//, "")
    const extension = path.extname(normalizedPath).slice(1).toLowerCase()
    const mediaType = imageTypes[extension as keyof typeof imageTypes]
    const file = archive.file(`${rootPath}${normalizedPath}`)
    if (!file || !mediaType) continue

    // uploadAsset 由文档处理流程注入，负责真正写 OSS 并返回站内 URL。
    const data = await file.async("nodebuffer")
    context.signal?.throwIfAborted()
    const url = await context.uploadAsset({
      data,
      mediaType,
    })
    context.signal?.throwIfAborted()
    output = output.split(`](${imagePath})`).join(`](${url})`)
  }

  return output
}

/**
 * 为 PDF 或 DOCX 创建一个符合 KnowledgeDocumentParser 接口的 MinerU 解析器。
 */
export function createMineruParser(
  kind: Extract<KnowledgeSourceKind, "pdf" | "docx">
): KnowledgeDocumentParser {
  return {
    kind,
    version: `mineru-${kind}@1`,
    async parse(input, context) {
      context.signal?.throwIfAborted()
      // MinerU 返回 Markdown 和资源 ZIP；先把图片迁回本站再保存正文。
      const result = await parseWithMineru(
        input,
        context.filename,
        context.signal
      )
      const markdown = normalizeText(
        await uploadMineruImages(
          result.markdown,
          result.archive,
          result.rootPath,
          context
        )
      ).trim()

      context.signal?.throwIfAborted()
      // markdownContent 是后续正文预览和分块使用的唯一正文。
      assertMarkdownSize(markdown)
      return {
        markdown,
        metadata: {
          format: kind,
          provider: "mineru",
          batchId: result.batchId,
          modelVersion: result.modelVersion,
          originalFileName: context.filename,
        },
        sections: extractMarkdownSections(markdown),
        warnings: [],
      }
    },
  }
}
