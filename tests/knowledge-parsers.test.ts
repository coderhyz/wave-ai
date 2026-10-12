/**
 * 知识库解析器测试。
 * 这里使用最小文件和模拟 MinerU 响应，验证格式识别、Markdown 输出和错误处理。
 */
import iconv from "iconv-lite"
import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import { markdownParser } from "@/lib/knowledge/parsers/markdown-pass-through"
import {
  getKnowledgeParser,
  inspectKnowledgeFile,
} from "@/lib/knowledge/parsers/registry"
import { txtParser } from "@/lib/knowledge/parsers/txt-to-markdown"
import { KnowledgeParseError } from "@/lib/knowledge/parsers/types"

// 构造只包含文件签名的最小样本，避免测试依赖真实文档。
const createSimplePdf = () => Buffer.from("%PDF-1.4\n%%EOF")

const createSimpleDocx = async () => {
  const zip = new JSZip()
  zip.file("word/document.xml", "<document />")
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" })
}

// 模拟 MinerU 的“申请上传地址 -> 上传 -> 查询结果 -> 下载 ZIP”完整调用链。
const mockMineru = async (markdown: string) => {
  const zip = new JSZip()
  zip.file("result/full.md", markdown)
  zip.file("result/images/figure.png", Buffer.from("image"))
  const zipBuffer = await zip.generateAsync({ type: "arraybuffer" })
  vi.stubEnv("MINERU_API_TOKEN", "test-token")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const value = String(url)
      if (value.endsWith("/api/v4/file-urls/batch")) {
        return Response.json({
          code: 0,
          data: { batch_id: "batch-1", file_urls: ["https://upload.test"] },
        })
      }
      if (value === "https://upload.test") return new Response(null)
      if (value.endsWith("/api/v4/extract-results/batch/batch-1")) {
        return Response.json({
          code: 0,
          data: {
            extract_result: [
              { state: "done", full_zip_url: "https://result.test/result.zip" },
            ],
          },
        })
      }
      if (value === "https://result.test/result.zip") {
        return new Response(zipBuffer)
      }
      throw new Error(`Unexpected URL: ${value}`)
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("knowledge document parsers", () => {
  it("keeps Markdown content and extracts heading locators", async () => {
    const result = await markdownParser.parse(
      Buffer.from("# 标题\n\n## 小节\n正文"),
      { filename: "README.md", mimeType: "text/markdown" }
    )

    expect(result.markdown).toBe("# 标题\n\n## 小节\n正文")
    expect(result.sections).toHaveLength(2)
    expect(result.sections[1].locator.headingPath).toEqual(["标题", "小节"])
  })

  it("decodes GB18030 TXT and prevents accidental headings", async () => {
    const result = await txtParser.parse(
      iconv.encode("# 普通文本\n\n- 列表项", "gb18030"),
      { filename: "说明.txt", mimeType: "text/plain" }
    )

    expect(result.markdown).toContain("# 说明")
    expect(result.markdown).toContain("\\# 普通文本")
    expect(result.markdown).toContain("- 列表项")
  })

  it("rejects a fake PDF before parsing", () => {
    expect(() =>
      inspectKnowledgeFile({
        buffer: Buffer.from("not a pdf"),
        filename: "fake.pdf",
        mimeType: "application/pdf",
      })
    ).toThrowError(KnowledgeParseError)
  })

  it("parses PDF through MinerU", async () => {
    await mockMineru("# 示例\n\n## 第一页\n\nHello PDF")
    const result = await getKnowledgeParser("pdf").parse(createSimplePdf(), {
      filename: "sample.pdf",
      mimeType: "application/pdf",
    })

    expect(result.metadata.provider).toBe("mineru")
    expect(result.markdown).toContain("Hello PDF")
    expect(result.sections).toHaveLength(2)
  })

  it("parses DOCX through MinerU", async () => {
    await mockMineru(
      "# 项目进度报告\n\n| 阶段 | 状态 |\n| --- | --- |\n| 需求分析 | 已完成 |"
    )
    const input = await createSimpleDocx()
    const inspected = inspectKnowledgeFile({
      buffer: input,
      filename: "项目报告.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
    const result = await getKnowledgeParser("docx").parse(input, {
      filename: "项目报告.docx",
      mimeType: inspected.mimeType,
    })

    expect(result.metadata.provider).toBe("mineru")
    expect(result.markdown).toContain("| 需求分析 | 已完成 |")
  })

  it("rejects MIME and extension mismatches", () => {
    expect(() =>
      inspectKnowledgeFile({
        buffer: Buffer.from("hello"),
        filename: "note.txt",
        mimeType: "application/pdf",
      })
    ).toThrowError(/MIME/)
  })

  it("uploads MinerU images and replaces their Markdown paths", async () => {
    await mockMineru("# 图片\n\n![图片](images/figure.png)")
    const uploadAsset = vi
      .fn()
      .mockResolvedValue("/api/knowledge-documents/id/assets/image.png")
    const result = await getKnowledgeParser("pdf").parse(createSimplePdf(), {
      filename: "sample.pdf",
      mimeType: "application/pdf",
      uploadAsset,
    })
    expect(uploadAsset).toHaveBeenCalledWith({
      data: Buffer.from("image"),
      mediaType: "image/png",
    })
    expect(result.markdown).toBe(
      "# 图片\n\n![图片](/api/knowledge-documents/id/assets/image.png)"
    )
  })

  it("surfaces MinerU task creation failures", async () => {
    await mockMineru("# 示例")
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ code: -1, msg: "服务不可用" }, { status: 503 })
    )
    await expect(
      getKnowledgeParser("pdf").parse(createSimplePdf(), {
        filename: "sample.pdf",
        mimeType: "application/pdf",
      })
    ).rejects.toMatchObject({
      code: "PARSE_FAILED",
      message: "MinerU 创建任务失败：服务不可用",
      retryable: true,
    })
  })

  it("keeps paragraph ranges when TXT paragraphs repeat", async () => {
    const result = await txtParser.parse(
      Buffer.from("重复段落\n\n重复段落\n\n最后一段"),
      {
        filename: "说明.txt",
        mimeType: "text/plain",
      }
    )
    expect(
      result.sections.map(({ startOffset, endOffset }) =>
        result.markdown.slice(startOffset, endOffset)
      )
    ).toEqual(["重复段落", "重复段落", "最后一段"])
    expect(result.sections.map(({ locator }) => locator.paragraph)).toEqual([
      1, 2, 3,
    ])
  })
})
