import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chunkMarkdown } from "@/lib/knowledge/indexing/chunk"
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedDocumentChunks,
  embedQuery,
} from "@/lib/knowledge/indexing/embedding"

vi.mock("server-only", () => ({}))

interface EmbeddingRequest {
  model: string
  input: { texts: string[] }
  parameters: {
    text_type: "document" | "query"
    dimension: number
    output_type: string
  }
}

const readRequest = (init?: RequestInit): EmbeddingRequest =>
  JSON.parse(String(init?.body))

let nextEmbedding = 0
const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
  init?.signal?.throwIfAborted()
  const request = readRequest(init)
  const embeddings = request.input.texts.map((_, text_index) => {
    const embedding = Array<number>(EMBEDDING_DIMENSIONS).fill(0)
    embedding[0] = nextEmbedding++
    embedding[1] = 1
    return { text_index, embedding }
  })
  return Response.json({
    // 模拟供应商返回乱序结果，验证真实 SDK 按 text_index 还原顺序。
    output: { embeddings: embeddings.reverse() },
    usage: { total_tokens: 10 },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
  nextEmbedding = 0
  vi.stubEnv("QWEN_API_KEY", "test-qwen-key")
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("knowledge embeddings", () => {
  it("uses one model and dimension for document and query inputs", async () => {
    const chunks = await chunkMarkdown("# 上传\n\n选择文件")
    const originalChunks = structuredClone(chunks)
    const document = await embedDocumentChunks({
      documentTitle: "使用手册",
      chunks,
    })
    const query = await embedQuery(" \uFEFF如何上传？\r\n ")

    expect(document.embeddingModel).toBe(EMBEDDING_MODEL)
    expect(query.embeddingModel).toBe(document.embeddingModel)
    expect(document.embeddings[0]).toHaveLength(1024)
    expect(query.embedding).toHaveLength(1024)
    expect(chunks).toEqual(originalChunks)

    const documentRequest = readRequest(fetchMock.mock.calls[0][1])
    const queryRequest = readRequest(fetchMock.mock.calls[1][1])
    expect(documentRequest).toEqual({
      model: "text-embedding-v4",
      input: { texts: ["使用手册\n\n上传\n\n# 上传\n\n选择文件"] },
      parameters: {
        text_type: "document",
        dimension: 1024,
        output_type: "dense",
      },
    })
    expect(queryRequest).toEqual({
      model: documentRequest.model,
      input: { texts: ["如何上传？"] },
      parameters: { text_type: "query", dimension: 1024, output_type: "dense" },
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
    )
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")
    ).toBe("Bearer test-qwen-key")
  })

  it("splits more than 10 chunks into native batches and keeps their order", async () => {
    const markdown = Array.from(
      { length: 23 },
      (_, index) => `# 第 ${index} 节\n\n正文 ${index}`
    ).join("\n\n")
    const chunks = await chunkMarkdown(markdown)
    const result = await embedDocumentChunks({ documentTitle: "手册", chunks })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => readRequest(init).input.texts.length
      )
    ).toEqual([10, 10, 3])
    expect(result.embeddings.map((embedding) => embedding[0])).toEqual(
      Array.from({ length: 23 }, (_, index) => index)
    )
    expect(
      fetchMock.mock.calls.flatMap(([, init]) => readRequest(init).input.texts)
    ).toEqual(
      chunks.map(
        (chunk) =>
          `手册\n\n${chunk.metadata.headingPath.join(" / ")}\n\n${chunk.content}`
      )
    )
  })

  it("normalizes text for both inputs without rewriting the stored chunk", async () => {
    const chunks = await chunkMarkdown("正文\r\n第二行\u0000")
    const originalContent = chunks[0].content
    await embedDocumentChunks({ documentTitle: "\uFEFF标题\r\n", chunks })
    await embedQuery("\uFEFF正文\r\n第二行\u0000")

    expect(readRequest(fetchMock.mock.calls[0][1]).input.texts).toEqual([
      "标题\n\n正文\n第二行",
    ])
    expect(readRequest(fetchMock.mock.calls[1][1]).input.texts).toEqual([
      "正文\n第二行",
    ])
    expect(chunks[0].content).toBe(originalContent)
  })

  it("returns no document vectors and makes no request for zero chunks", async () => {
    vi.stubEnv("QWEN_API_KEY", undefined)
    expect(
      await embedDocumentChunks({ documentTitle: "空文档", chunks: [] })
    ).toEqual({ embeddingModel: EMBEDDING_MODEL, embeddings: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(["", " \r\n\t ", "\uFEFF\u0000"])(
    "rejects an empty query %j before sending a request",
    async (query) => {
      await expect(embedQuery(query)).rejects.toThrow("Embedding 问题不能为空")
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, "   "])(
    "fails clearly when the API key is missing or blank",
    async (apiKey) => {
      vi.stubEnv("QWEN_API_KEY", apiKey)
      await expect(embedQuery("问题")).rejects.toThrow("QWEN_API_KEY")
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it("rejects a vector whose dimension does not fit vector(1024)", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        output: { embeddings: [{ text_index: 0, embedding: [0.1, 0.2] }] },
      })
    )
    await expect(embedQuery("问题")).rejects.toThrow(
      "Embedding 维度不匹配：期望 1024，实际 2"
    )
  })

  it("lets the SDK reject missing vectors instead of misaligning chunks", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { embeddings: [] } })
    )
    await expect(embedQuery("问题")).rejects.toThrow(
      "Expected 1 embeddings, but received 0"
    )
  })

  it("exposes rate-limit errors without retrying or returning fake vectors", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: "Throttling", message: "Embedding rate limit" },
        { status: 429 }
      )
    )
    await expect(embedQuery("问题")).rejects.toThrow("Embedding rate limit")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("propagates caller cancellation to the underlying request", async () => {
    const controller = new AbortController()
    controller.abort(new Error("任务已取消"))
    await expect(embedQuery("问题", controller.signal)).rejects.toThrow(
      "任务已取消"
    )
  })

  it("aborts an in-flight request when its timeout signal fires", async () => {
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
    const result = embedQuery("问题")
    const assertion = expect(result).rejects.toThrow("Embedding 请求超时")
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
    timeout.abort(new DOMException("Embedding 请求超时", "TimeoutError"))
    await assertion
  })
})
