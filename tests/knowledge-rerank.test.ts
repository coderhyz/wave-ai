import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rerankChunks } from "@/lib/knowledge/retrieval/rerank"

vi.mock("server-only", () => ({}))

const endpoint =
  "https://test-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
const chunks = [
  {
    documentTitle: "手册",
    content: "点击上传按钮",
    metadata: { headingPath: ["文件", "上传"] },
  },
  { documentTitle: "手册", content: "支持的格式", metadata: null },
  { documentTitle: "说明", content: "其他内容", metadata: {} },
]
const results = [
  { index: 2, relevance_score: 0.1 },
  { index: 0, relevance_score: 0.4 },
  { index: 1, relevance_score: 0.9 },
]
const fetchMock = vi.fn<typeof fetch>()
const run = (abortSignal?: AbortSignal) =>
  rerankChunks({ query: "如何上传？", chunks, abortSignal })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("QWEN_API_KEY", "test-key")
  vi.stubEnv("RAG_RERANK_URL", endpoint)
  vi.stubEnv("RAG_RERANK_ENABLED", undefined)
  vi.stubEnv("RAG_RERANK_MODEL", undefined)
  vi.stubEnv("RAG_RERANK_MIN_SCORE", undefined)
  fetchMock.mockImplementation(async (_input, init) => {
    init?.signal?.throwIfAborted()
    return Response.json({ output: { results } })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("knowledge reranker API", () => {
  it("uses native DashScope input, scores every candidate and maps original indices", async () => {
    const original = structuredClone(chunks)
    expect(await run()).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.4 },
    ])
    expect(chunks).toEqual(original)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(endpoint)
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key"
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen3-rerank",
      input: {
        query: "如何上传？",
        documents: [
          "手册\n\n文件 / 上传\n\n点击上传按钮",
          "手册\n\n支持的格式",
          "说明\n\n其他内容",
        ],
      },
      parameters: { top_n: 3, return_documents: false },
    })
  })
  it("skips requests and required configuration when explicitly disabled", async () => {
    vi.stubEnv("RAG_RERANK_ENABLED", "false")
    vi.stubEnv("RAG_RERANK_URL", undefined)
    vi.stubEnv("QWEN_API_KEY", undefined)
    expect(await run()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("makes no request for empty candidates", async () => {
    expect(await rerankChunks({ query: "问题", chunks: [] })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("allows configuring the model and threshold", async () => {
    vi.stubEnv("RAG_RERANK_MODEL", "gte-rerank-v2")
    vi.stubEnv("RAG_RERANK_MIN_SCORE", "0.8")
    expect(await run()).toEqual([{ index: 1, score: 0.9 }])
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe(
      "gte-rerank-v2"
    )
  })
  it("distinguishes successful low scores from disabled reranking", async () => {
    vi.stubEnv("RAG_RERANK_MIN_SCORE", "1")
    expect(await run()).toEqual([])
  })
  it("bounds model input without changing stored content", async () => {
    const content = "正文".repeat(2000)
    fetchMock.mockResolvedValueOnce(
      Response.json({
        output: { results: [{ index: 0, relevance_score: 0.9 }] },
      })
    )
    await rerankChunks({
      query: "问题",
      chunks: [
        {
          documentTitle: "长文档",
          content,
          metadata: { headingPath: ["章节"] },
        },
      ],
    })
    const document = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).input
      .documents[0]
    expect(document).toHaveLength(2000)
    expect(document.startsWith("长文档\n\n章节\n\n")).toBe(true)
    expect(content).toHaveLength(4000)
  })
  it.each([
    ["QWEN_API_KEY", undefined],
    ["QWEN_API_KEY", " "],
    ["RAG_RERANK_URL", undefined],
    ["RAG_RERANK_URL", "not-a-url"],
    ["RAG_RERANK_URL", "http://example.com/rerank"],
    ["RAG_RERANK_MODEL", " "],
    ["RAG_RERANK_ENABLED", "yes"],
    ["RAG_RERANK_MIN_SCORE", "NaN"],
    ["RAG_RERANK_MIN_SCORE", "-1"],
    ["RAG_RERANK_MIN_SCORE", "1.1"],
  ])(
    "rejects invalid configuration %s=%j before a request",
    async (name, value) => {
      vi.stubEnv(name, value)
      await expect(run()).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
  it.each([401, 429, 500])(
    "exposes HTTP %i without extra retries",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ code: "Error" }, { status })
      )
      await expect(run()).rejects.toThrow(`HTTP ${status}`)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )
  it.each([
    { code: "InvalidApiKey", message: "invalid key" },
    { code: "Error", output: { results } },
    { output: { results: [] } },
    { output: { results: results.slice(0, 2) } },
    { output: { results: [...results, results[0]] } },
    { output: { results: [results[0], results[0], results[1]] } },
    {
      output: {
        results: [{ index: 3, relevance_score: 0.9 }, ...results.slice(1)],
      },
    },
    {
      output: {
        results: [{ index: -1, relevance_score: 0.9 }, ...results.slice(1)],
      },
    },
    {
      output: {
        results: [{ index: 0.5, relevance_score: 0.9 }, ...results.slice(1)],
      },
    },
    {
      output: {
        results: [{ index: 2, relevance_score: 1.1 }, ...results.slice(1)],
      },
    },
    {
      output: {
        results: [{ index: 2, relevance_score: -0.1 }, ...results.slice(1)],
      },
    },
    {
      output: {
        results: [{ index: 2, relevance_score: "0.9" }, ...results.slice(1)],
      },
    },
  ])("rejects an invalid or incomplete model response: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body))
    await expect(run()).rejects.toThrow()
  })
  it("rejects malformed JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not JSON"))
    await expect(run()).rejects.toThrow()
  })
  it("propagates network errors", async () => {
    const error = new Error("connection reset")
    fetchMock.mockRejectedValueOnce(error)
    await expect(run()).rejects.toBe(error)
  })
  it("does not start a request for an already cancelled caller", async () => {
    const controller = new AbortController()
    const error = new Error("已取消")
    controller.abort(error)
    await expect(run(controller.signal)).rejects.toBe(error)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(["caller", "timeout"])(
    "aborts an in-flight request on %s cancellation",
    async (source) => {
      const caller = new AbortController()
      const timeout = new AbortController()
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(timeout.signal)
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true }
            )
          })
      )
      const error = new Error(`${source} aborted`)
      const pending = run(caller.signal)
      const assertion = expect(pending).rejects.toBe(error)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(timeoutSpy).toHaveBeenCalledWith(10_000)
      const cancellation = source === "caller" ? caller : timeout
      cancellation.abort(error)
      await assertion
    }
  )
})
