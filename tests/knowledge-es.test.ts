import { beforeEach, describe, expect, it, vi } from "vitest"
import { errors } from "@elastic/elasticsearch"
import {
  getKnowledgeChunkId,
  type KnowledgeChunk,
} from "@/lib/knowledge/indexing/chunk"
import {
  deleteKnowledgeChunks,
  ensureKnowledgeChunkIndex,
  indexKnowledgeChunks,
  KNOWLEDGE_CHUNK_INDEX,
  searchKeywordChunks,
} from "@/lib/es/knowledge-index"

const { client } = vi.hoisted(() => ({
  client: {
    indices: { exists: vi.fn(), create: vi.fn() },
    bulk: vi.fn(),
    deleteByQuery: vi.fn(),
    search: vi.fn(),
  },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/es/es", () => ({ getEsClient: () => client }))

const chunk: KnowledgeChunk = {
  chunkIndex: 0,
  content: "选择文件",
  metadata: { headingPath: ["操作", "上传"], startOffset: 10, endOffset: 14 },
}
const params = {
  userId: "owner",
  knowledgeBaseId: "base",
  documentId: "doc",
  documentTitle: "手册",
  contentRevision: 4,
  chunks: [chunk],
}
const search = () =>
  searchKeywordChunks({
    userId: "owner",
    query: "上传文件",
    documentVersions: ["doc:4"],
    limit: 20,
  })
beforeEach(() => {
  vi.resetAllMocks()
  client.indices.exists.mockResolvedValue(true)
  client.indices.create.mockResolvedValue({ acknowledged: true })
  client.bulk.mockResolvedValue({ errors: false, items: [] })
  client.deleteByQuery.mockResolvedValue({ timed_out: false, failures: [] })
  client.search.mockResolvedValue({
    timed_out: false,
    _shards: { failed: 0 },
    hits: { hits: [{ _id: "a", _score: 2.5 }] },
  })
})

describe("ES keyword index", () => {
  it("creates a strict keyword/text mapping with a built-in Chinese analyzer", async () => {
    client.indices.exists.mockResolvedValue(false)
    await ensureKnowledgeChunkIndex()
    expect(client.indices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        index: KNOWLEDGE_CHUNK_INDEX,
        mappings: expect.objectContaining({
          dynamic: "strict",
          properties: expect.objectContaining({
            userId: { type: "keyword" },
            documentVersion: { type: "keyword" },
            content: { type: "text", analyzer: "cjk" },
          }),
        }),
      })
    )
  })
  it("does not recreate an existing index", async () => {
    await ensureKnowledgeChunkIndex()
    expect(client.indices.create).not.toHaveBeenCalled()
  })
  it("tolerates another worker winning the first-create race", async () => {
    client.indices.exists.mockResolvedValue(false)
    const error = Object.create(errors.ResponseError.prototype, {
      body: { value: { error: { type: "resource_already_exists_exception" } } },
    })
    client.indices.create.mockRejectedValue(error)
    await expect(ensureKnowledgeChunkIndex()).resolves.toBeUndefined()
  })
  it("propagates other index initialization errors", async () => {
    client.indices.exists.mockResolvedValue(false)
    const error = new Error("forbidden")
    client.indices.create.mockRejectedValue(error)
    await expect(ensureKnowledgeChunkIndex()).rejects.toBe(error)
  })
  it("writes idempotent version-specific IDs and waits for search visibility", async () => {
    await indexKnowledgeChunks(params)
    await indexKnowledgeChunks(params)
    const expected = getKnowledgeChunkId("doc", 4, 0)
    for (const [request] of client.bulk.mock.calls) {
      expect(request).toMatchObject({
        index: KNOWLEDGE_CHUNK_INDEX,
        refresh: "wait_for",
        operations: [
          { index: { _id: expected } },
          {
            documentVersion: "doc:4",
            heading: "操作 / 上传",
            content: "选择文件",
            userId: "owner",
          },
        ],
      })
    }
    expect(expected).not.toBe(getKnowledgeChunkId("doc", 5, 0))
    expect(client.deleteByQuery).toHaveBeenCalledWith(
      {
        index: KNOWLEDGE_CHUNK_INDEX,
        refresh: true,
        query: {
          bool: {
            filter: [
              { term: { documentId: "doc" } },
              { range: { contentRevision: { lt: 4 } } },
            ],
          },
        },
      },
      expect.any(Object)
    )
  })
  it("bounds bulk requests to 100 chunks", async () => {
    await indexKnowledgeChunks({
      ...params,
      chunks: Array.from({ length: 101 }, (_, i) => ({
        ...chunk,
        chunkIndex: i,
      })),
    })
    expect(
      client.bulk.mock.calls.map(([request]) => request.operations.length)
    ).toEqual([200, 2])
  })
  it("still clears old versions for an empty body", async () => {
    await indexKnowledgeChunks({ ...params, chunks: [] })
    expect(client.bulk).not.toHaveBeenCalled()
    expect(client.deleteByQuery).toHaveBeenCalledOnce()
  })
  it("fails on HTTP-200 bulk item errors without deleting the old version", async () => {
    client.bulk.mockResolvedValue({
      errors: true,
      items: [{ index: { error: { reason: "mapping rejected" } } }],
    })
    await expect(indexKnowledgeChunks(params)).rejects.toThrow(
      "mapping rejected"
    )
    expect(client.deleteByQuery).not.toHaveBeenCalled()
  })
  it.each([{ timed_out: true }, { failures: [{ reason: "conflict" }] }])(
    "fails when cleanup is incomplete: %j",
    async (result) => {
      client.deleteByQuery.mockResolvedValue(result)
      await expect(indexKnowledgeChunks(params)).rejects.toThrow("清理失败")
    }
  )
  it("restricts BM25 to the owner's current versions and boosts titles/headings", async () => {
    expect(await search()).toEqual([{ chunkId: "a", score: 2.5 }])
    expect(client.search).toHaveBeenCalledWith(
      {
        index: KNOWLEDGE_CHUNK_INDEX,
        size: 20,
        _source: false,
        allow_partial_search_results: false,
        query: {
          bool: {
            filter: [
              { term: { userId: "owner" } },
              { terms: { documentVersion: ["doc:4"] } },
            ],
            must: [
              {
                multi_match: {
                  query: "上传文件",
                  fields: ["documentTitle^2", "heading^2", "content"],
                },
              },
            ],
          },
        },
      },
      expect.any(Object)
    )
  })
  it.each([
    { timed_out: true, _shards: { failed: 0 } },
    { timed_out: false, _shards: { failed: 1 } },
  ])("rejects incomplete search results: %j", async (result) => {
    client.search.mockResolvedValue(result)
    await expect(search()).rejects.toThrow("未完整完成")
  })
  it("fails clearly for ES downtime", async () => {
    client.search.mockRejectedValue(new Error("connection refused"))
    await expect(search()).rejects.toThrow("connection refused")
  })
  it("deletes a removed document's keyword chunks", async () => {
    await deleteKnowledgeChunks("doc")
    expect(client.deleteByQuery).toHaveBeenCalledWith(
      {
        index: KNOWLEDGE_CHUNK_INDEX,
        refresh: true,
        query: { term: { documentId: "doc" } },
      },
      { maxRetries: 0 }
    )
  })
  it("treats a missing index as already cleaned", async () => {
    client.indices.exists.mockResolvedValue(false)
    await deleteKnowledgeChunks("doc")
    expect(client.deleteByQuery).not.toHaveBeenCalled()
    expect(client.indices.create).not.toHaveBeenCalled()
  })
  it("keeps document cleanup retryable on a partial failure", async () => {
    client.deleteByQuery.mockResolvedValue({ failures: [{}] })
    await expect(deleteKnowledgeChunks("doc")).rejects.toThrow("清理失败")
  })
})
