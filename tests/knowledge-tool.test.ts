import { beforeEach, describe, expect, it, vi } from "vitest"
import { asSchema, generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { createKnowledgeSearchTool } from "@/lib/ai/tool/knowledge-search"

const { search } = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/knowledge/retrieval/search", () => ({ searchKnowledge: search }))

const knowledgeBaseId = "10000000-0000-4000-8000-000000000001"
const documentId = "20000000-0000-4000-8000-000000000001"
const result = {
  items: [{ chunkId: "chunk-1", documentId, content: "点击上传按钮" }],
  warnings: [{ stage: "rerank", message: "重排失败，本次使用 RRF 排序" }],
}
const createTool = (scopeDocumentId?: string) =>
  createKnowledgeSearchTool({ userId: "owner", documentId: scopeDocumentId })

// 让真实 AI SDK 解析模型工具参数并执行工具，只模拟模型和底层检索。
const callFromModel = (input: unknown, scopeDocumentId?: string) =>
  generateText({
    model: new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "searchKnowledge",
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    }),
    prompt: "如何上传？",
    tools: { searchKnowledge: createTool(scopeDocumentId) },
    maxRetries: 0,
  })

beforeEach(() => {
  vi.resetAllMocks()
  search.mockResolvedValue(result)
})

describe("knowledge search tool", () => {
  it("exposes only the query argument to the model", async () => {
    const schema = await asSchema(createTool().inputSchema).jsonSchema
    expect(schema).toMatchObject({
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    })
    expect(Object.keys(schema.properties ?? {})).toEqual(["query"])
  })
  it("normalizes model input and searches all knowledge bases of the authenticated user by default", async () => {
    const response = await callFromModel({
      query: "\uFEFF 上传\r\n文件\u0000 ",
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0].slice(0, 2)).toEqual([
      "owner",
      {
        query: "上传\n文件",
        documentId: undefined,
        mode: "hybrid",
        limit: 6,
      },
    ])
    expect(response.toolResults[0]).toMatchObject({
      toolName: "searchKnowledge",
      output: result,
    })
  })
  it.each([
    { query: " " },
    { query: "\u0000\u0001" },
    { query: "a".repeat(2001) },
    { query: "上传", userId: "another-user" },
    { query: "上传", knowledgeBaseId },
    { query: "上传", documentId: "another-document" },
    { query: "上传", mode: "vector" },
    { query: "上传", limit: 20 },
  ])(
    "rejects invalid input or attempts to change server-bound scope: %j",
    async (input) => {
      const response = await callFromModel(input)
      expect(response.toolCalls[0]).toMatchObject({ invalid: true })
      expect(search).not.toHaveBeenCalled()
    }
  )
  it("limits preview searches to the current document bound by the server", async () => {
    await callFromModel({ query: "文档内容是什么？" }, documentId)
    expect(search.mock.calls[0].slice(0, 2)).toEqual([
      "owner",
      { query: "文档内容是什么？", documentId, mode: "hybrid", limit: 6 },
    ])
  })
  it("keeps request identities isolated when multiple tools are created", async () => {
    const other = createKnowledgeSearchTool({
      userId: "other-owner",
      documentId,
    })
    const options = { toolCallId: "tool-1", messages: [], context: {} }
    await createTool().execute({ query: "问题一" }, options)
    await other.execute({ query: "问题二" }, options)
    expect(
      search.mock.calls.map(([userId, input]) => [
        userId,
        input.knowledgeBaseId,
        input.documentId,
      ])
    ).toEqual([
      ["owner", undefined, undefined],
      ["other-owner", undefined, documentId],
    ])
  })
  it("passes caller cancellation through to the existing retrieval flow", async () => {
    const controller = new AbortController()
    const error = new Error("用户已取消")
    controller.abort(error)
    search.mockImplementation(async (_userId, _input, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return result
    })
    await expect(
      createTool().execute(
        { query: "上传" },
        {
          toolCallId: "tool-1",
          messages: [],
          context: {},
          abortSignal: controller.signal,
        }
      )
    ).rejects.toBe(error)
  })
  it("lets the SDK report retrieval failure instead of returning fake empty hits", async () => {
    const error = new Error("database unavailable")
    search.mockRejectedValueOnce(error)
    const response = await callFromModel({ query: "上传" })
    expect(response.toolResults).toEqual([])
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-error",
          toolName: "searchKnowledge",
          error,
        }),
      ])
    )
  })
  it("preserves an empty result and its degradation warnings", async () => {
    const empty = { items: [], warnings: result.warnings }
    search.mockResolvedValueOnce(empty)
    const response = await callFromModel({ query: "不存在的内容" })
    expect(response.toolResults[0]).toMatchObject({ output: empty })
  })
})
