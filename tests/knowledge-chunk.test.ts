import { describe, expect, it } from "vitest"
import { chunkMarkdown } from "@/lib/knowledge/indexing/chunk"
import { extractMarkdownSections } from "@/lib/knowledge/parsers/normalize"
import { txtParser } from "@/lib/knowledge/parsers/txt-to-markdown"

describe("knowledge Markdown chunks", () => {
  it("keeps preamble and separates heading paths without crossing chapters", async () => {
    const markdown =
      "前言\n\n# 使用说明\n正文\n\n## 上传\n上传说明\n\n# 常见问题\n问题"
    const chunks = await chunkMarkdown(markdown)

    expect(chunks.map(({ content }) => content)).toEqual([
      "前言",
      "# 使用说明\n正文",
      "## 上传\n上传说明",
      "# 常见问题\n问题",
    ])
    expect(chunks.map(({ metadata }) => metadata.headingPath)).toEqual([
      [],
      ["使用说明"],
      ["使用说明", "上传"],
      ["常见问题"],
    ])
    for (const chunk of chunks) {
      expect(
        markdown.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)
      ).toBe(chunk.content)
    }
  })

  it.each(["", " \n\t "])(
    "produces no chunks for an empty body %j",
    async (markdown) => {
      expect(await chunkMarkdown(markdown)).toEqual([])
    }
  )

  it("splits long Chinese text with bounded size, overlap and full coverage", async () => {
    const markdown =
      "# 中文\n\n" + "分块需要保留原文内容，检索时才能找到依据。".repeat(180)
    const chunks = await chunkMarkdown(markdown)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].metadata.startOffset).toBe(0)
    expect(chunks.at(-1)?.metadata.endOffset).toBe(markdown.length)
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.chunkIndex).toBe(index)
      expect(chunk.content.length).toBeLessThanOrEqual(512)
      expect(chunk.metadata.headingPath).toEqual(["中文"])
      expect(
        markdown.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)
      ).toBe(chunk.content)
      if (index > 0) {
        const previous = chunks[index - 1]
        expect(chunk.metadata.startOffset).toBeLessThanOrEqual(
          previous.metadata.endOffset
        )
        expect(
          previous.metadata.endOffset - chunk.metadata.startOffset
        ).toBeLessThanOrEqual(64)
        expect(chunk.metadata.endOffset).toBeGreaterThan(
          previous.metadata.endOffset
        )
      }
    }
    expect(await chunkMarkdown(markdown)).toEqual(chunks)
  })

  it("locates repeated text at advancing offsets rather than matching the first copy", async () => {
    const markdown = "相同正文".repeat(900)
    const chunks = await chunkMarkdown(markdown)

    expect(chunks.at(-1)?.metadata.endOffset).toBe(markdown.length)
    for (const [index, chunk] of chunks.entries()) {
      expect(
        markdown.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)
      ).toBe(chunk.content)
      if (index > 0) {
        expect(chunk.metadata.startOffset).toBeGreaterThan(
          chunks[index - 1].metadata.startOffset
        )
        expect(chunk.metadata.startOffset).toBe(
          chunks[index - 1].metadata.endOffset - 64
        )
      }
    }
  })

  it.each(["***", "---", "___"])(
    "prefers the Markdown %s rule over paragraph boundaries",
    async (rule) => {
      const before = "a".repeat(180) + "\n\n" + "b".repeat(180)
      const after = "c".repeat(180) + "\n\n" + "d".repeat(180)
      const markdown = `${before}\n\n${rule}\n\n${after}`
      const chunks = await chunkMarkdown(markdown)

      expect(chunks).toHaveLength(2)
      expect(chunks[0].content).toBe(before)
      expect(chunks[1].content).toContain(`\n\n${rule}\n\n${after}`)
      const overlap = before.length - chunks[1].metadata.startOffset
      expect(overlap).toBeGreaterThan(0)
      expect(overlap).toBeLessThanOrEqual(64)
      expect(chunks[1].metadata.endOffset).toBe(markdown.length)
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(512)
        expect(
          markdown.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)
        ).toBe(chunk.content)
      }
    }
  )

  it.each(["```", "~~~~"])(
    "ignores headings inside %s fenced code",
    async (fence) => {
      const markdown = `# 示例\n\n${fence}sh\n# 代码注释\necho ok\n${fence}\n\n## 结果\n完成`
      const sections = extractMarkdownSections(markdown)

      expect(sections.map(({ locator }) => locator.headingPath)).toEqual([
        ["示例"],
        ["示例", "结果"],
      ])
      const chunks = await chunkMarkdown(markdown, sections)
      expect(chunks[0].content).toContain(
        `${fence}sh\n# 代码注释\necho ok\n${fence}`
      )
    }
  )

  it("keeps a short table and formula intact within a chapter", async () => {
    const markdown =
      "# 数据\n\n| 名称 | 数值 |\n| --- | --- |\n| A | 1 |\n\n$$\nx = 1\n$$"
    const chunks = await chunkMarkdown(markdown)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(markdown)
  })

  it("retains preamble when previously saved sections start at the first heading", async () => {
    const markdown = "旧版前言\n\n# 标题\n正文"
    const chunks = await chunkMarkdown(markdown, [
      {
        startOffset: markdown.indexOf("#"),
        endOffset: markdown.length,
        locator: { headingPath: ["标题"] },
      },
    ])

    expect(chunks.map(({ content }) => content)).toEqual([
      "旧版前言",
      "# 标题\n正文",
    ])
  })

  it("keeps offsets in the untrimmed input", async () => {
    const [chunk] = await chunkMarkdown(" \nabc\n ")

    expect(chunk).toEqual({
      chunkIndex: 0,
      content: "abc",
      metadata: { headingPath: [], startOffset: 2, endOffset: 5 },
    })
  })

  it("uses existing paragraph and page locators and preserves the TXT prefix", async () => {
    const parsed = await txtParser.parse(Buffer.from("第一段\n\n第二段"), {
      filename: "说明.txt",
      mimeType: "text/plain",
    })
    const sections = parsed.sections.map((section) => ({
      ...section,
      locator: { ...section.locator, page: 2 },
    }))
    const chunks = await chunkMarkdown(parsed.markdown, sections)

    expect(chunks.map(({ content }) => content)).toEqual([
      "# 说明",
      "第一段",
      "第二段",
    ])
    expect(chunks[1].metadata).toMatchObject({ page: 2, paragraph: 1 })
    expect(chunks[2].metadata).toMatchObject({ page: 2, paragraph: 2 })
  })
})
