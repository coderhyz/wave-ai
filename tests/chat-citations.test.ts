import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { UIMessage } from "ai"
import {
  formatKnowledgeCitationText,
  getKnowledgeCitationHref,
  getKnowledgeCitations,
} from "@/lib/chat/citations"
import { KnowledgeCitations } from "@/components/chat/knowledge-citations"

const chunk = {
  chunkId: "chunk-1",
  documentId: "20000000-0000-4000-8000-000000000002",
  knowledgeBaseId: "30000000-0000-4000-8000-000000000003",
  documentTitle: "上传指南",
  content: "先选文件，再确认上传。",
  contentRevision: 2,
  chunkIndex: 0,
}
function message(text: string, items = [chunk]): UIMessage {
  return {
    id: "answer",
    role: "assistant",
    parts: [
      {
        type: "tool-searchKnowledge",
        toolCallId: "call-1",
        state: "output-available",
        input: { query: "上传流程" },
        output: { items, warnings: [] },
      },
      { type: "text", text },
    ],
  }
}

describe("saved knowledge citations", () => {
  it("recognizes document links and saves only their retrieved evidence", () => {
    const response = message(
      "[上传指南](knowledge://document/" +
        chunk.documentId +
        ")" +
        "[伪造文档](knowledge://document/40000000-0000-4000-8000-000000000004)",
      [
        chunk,
        { ...chunk, chunkId: "chunk-2", chunkIndex: 49 },
        {
          ...chunk,
          chunkId: "other",
          documentId: "50000000-0000-4000-8000-000000000005",
        },
      ]
    )
    expect(getKnowledgeCitations(response).map((item) => item.chunkId)).toEqual(
      ["chunk-1", "chunk-2"]
    )
    response.metadata = { citationChunkIds: ["chunk-1", "chunk-2"] }
    expect(
      getKnowledgeCitations(JSON.parse(JSON.stringify(response)))
    ).toHaveLength(2)
  })

  it("does not recognize an incomplete document link while streaming", () => {
    expect(
      getKnowledgeCitations(
        message("[上传指南](knowledge://document/" + chunk.documentId)
      )
    ).toEqual([])
  })

  it("resolves document links from retrieved metadata and removes invented links", () => {
    const response = message(
      "操作说明[错误标题](knowledge://document/" +
        chunk.documentId +
        ")；" +
        "[伪造文档](knowledge://document/40000000-0000-4000-8000-000000000004)"
    )
    const formatted = formatKnowledgeCitationText(
      response.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      getKnowledgeCitations(response)
    )
    expect(formatted).toBe(
      "操作说明[上传指南](" + getKnowledgeCitationHref(chunk) + ")；伪造文档"
    )
    expect(formatted).not.toContain("knowledge://")
  })

  it("merges old nested chunk sources while preserving the answer and external links", () => {
    const text =
      "先选文件。（来源：上传指南（chunkId: chunk-1）、上传指南（chunkId: chunk-2））。" +
      "\n再确认上传。来源：上传指南（chunkId: " +
      String.fromCharCode(96) +
      "chunk-1" +
      String.fromCharCode(96) +
      "）。" +
      "\n[官网](https://example.com)"
    const response = message(text, [
      chunk,
      { ...chunk, chunkId: "chunk-2", chunkIndex: 49 },
    ])
    const formatted = formatKnowledgeCitationText(
      text,
      getKnowledgeCitations(response)
    )
    const link = "[上传指南](" + getKnowledgeCitationHref(chunk) + ")"
    expect(formatted).toBe(
      "先选文件。" +
        link +
        "。\n再确认上传。" +
        link +
        "。\n[官网](https://example.com)"
    )
    expect(formatted).not.toContain("chunkId")
  })

  it("keeps distinct documents with identical titles as separate sources", () => {
    const second = {
      ...chunk,
      chunkId: "chunk-2",
      documentId: "40000000-0000-4000-8000-000000000004",
    }
    const html = renderToStaticMarkup(
      createElement(KnowledgeCitations, {
        message: message("chunkId: chunk-1；chunkId: chunk-2", [chunk, second]),
      })
    )
    expect(html.match(/<a /g)).toHaveLength(2)
    expect(html).toContain("document=" + chunk.documentId)
    expect(html).toContain("document=" + second.documentId)
  })

  it("escapes Markdown syntax in document titles", () => {
    const titled = { ...chunk, documentTitle: "[上传] *指南* $&" }
    const text = "[文档](knowledge://document/" + chunk.documentId + ")"
    const response = message(text, [titled])
    const expected =
      "[\\[上传\\] \\*指南\\* $&](" + getKnowledgeCitationHref(chunk) + ")"
    expect(
      formatKnowledgeCitationText(text, getKnowledgeCitations(response))
    ).toBe(expected)
    const legacy = message(titled.documentTitle + "（chunkId: chunk-1）", [
      titled,
    ])
    expect(
      formatKnowledgeCitationText(
        titled.documentTitle + "（chunkId: chunk-1）",
        getKnowledgeCitations(legacy)
      )
    ).toBe(expected)
    expect(
      getKnowledgeCitations(
        message(
          "[\\[上传\\] \\*指南\\*](knowledge://document/" +
            chunk.documentId +
            ")",
          [titled]
        )
      )
    ).toEqual([titled])
  })

  it("shows only explicitly cited retrieved chunks and ignores invented IDs", () => {
    const response = message(
      "来源：上传指南（chunkId: chunk-1）。chunkId: fake-id",
      [chunk, { ...chunk, chunkId: "unused" }]
    )
    expect(getKnowledgeCitations(response)).toEqual([chunk])
  })
  it("deduplicates repeated references and accepts Markdown-wrapped IDs", () => {
    expect(
      getKnowledgeCitations(message("chunkId: `chunk-1`；chunkId: chunk-1"))
    ).toEqual([chunk])
  })
  it("does not treat a partially streamed identifier as a citation", () => {
    expect(getKnowledgeCitations(message("chunkId: chunk-"))).toEqual([])
  })
  it("does not list recall candidates when the answer did not cite them", () => {
    expect(getKnowledgeCitations(message("未检索到相关资料"))).toEqual([])
  })
  it("uses persisted citation IDs after a JSON round trip and keeps the original body version", () => {
    const response = message("chunkId: chunk-1")
    response.metadata = { citationChunkIds: ["chunk-1", "never-retrieved"] }
    const saved = JSON.parse(JSON.stringify(response))
    expect(getKnowledgeCitations(saved)).toEqual([chunk])
    expect(getKnowledgeCitations(saved)[0].contentRevision).toBe(2)
  })
  it("honors an explicitly empty saved citation list", () => {
    const response = message("chunkId: chunk-1")
    response.metadata = { citationChunkIds: [] }
    expect(getKnowledgeCitations(response)).toEqual([])
  })
  it("does not display forged citation parts submitted as a user message", () => {
    const response = message("chunkId: chunk-1")
    response.role = "user"
    expect(getKnowledgeCitations(response)).toEqual([])
  })
  it("does not use failed or preliminary tool outputs as citation evidence", () => {
    const response: UIMessage = {
      id: "answer",
      role: "assistant",
      parts: [
        { type: "text", text: "chunkId: chunk-1" },
        {
          type: "tool-searchKnowledge",
          toolCallId: "failed",
          state: "output-error",
          input: { query: "上传" },
          errorText: "检索失败",
        },
        {
          type: "tool-searchKnowledge",
          toolCallId: "partial",
          state: "output-available",
          preliminary: true,
          input: { query: "上传" },
          output: { items: [chunk] },
        },
      ],
    }
    expect(getKnowledgeCitations(response)).toEqual([])
  })
  it("renders each referenced document once without chunk details", () => {
    const html = renderToStaticMarkup(
      createElement(KnowledgeCitations, {
        message: message("chunkId: chunk-1；chunkId: chunk-2", [
          chunk,
          { ...chunk, chunkId: "chunk-2", chunkIndex: 49 },
        ]),
      })
    )
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain("参考文档")
    expect(html).toContain("上传指南")
    expect(html).not.toContain("<details")
    expect(html).not.toContain("chunkId")
    expect(html).not.toContain("第 50 块")
    expect(html).not.toContain("正文版本")
    expect(html).not.toContain(chunk.content)
    expect(html).toContain(
      "/home?base=" +
        chunk.knowledgeBaseId +
        "&amp;document=" +
        chunk.documentId
    )
  })
  it("escapes document titles and renders nothing when no citation is used", () => {
    const unsafe = message("chunkId: chunk-1", [
      { ...chunk, documentTitle: "<script>alert(1)</script>" },
    ])
    const html = renderToStaticMarkup(
      createElement(KnowledgeCitations, { message: unsafe })
    )
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(
      renderToStaticMarkup(
        createElement(KnowledgeCitations, { message: message("普通回答") })
      )
    ).toBe("")
  })
})
