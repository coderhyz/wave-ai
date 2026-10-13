import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Prisma } from "@/app/generated/prisma"
import { knowledgeSearchRoute } from "@/app/api/[[...route]]/knowledge-search"
import { searchKnowledgeSchema } from "@/lib/knowledge/schemas"
import { searchKnowledge } from "@/lib/knowledge/retrieval/search"

const { db, embedding, es, reranker } = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    knowledgeBase: { findFirst: vi.fn() },
    knowledgeDocument: { findFirst: vi.fn() },
  },
  embedding: { embedQuery: vi.fn() },
  es: { searchKeywordChunks: vi.fn() },
  reranker: { rerankChunks: vi.fn() },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/knowledge/indexing/embedding", () => embedding)
vi.mock("@/lib/es/knowledge-index", () => es)
vi.mock("@/lib/knowledge/retrieval/rerank", () => reranker)
vi.mock("@/lib/hono/hono-middware", async () => {
  const { createMiddleware } = await import("hono/factory")
  return {
    getAuthUser: createMiddleware<{ Variables: { user: { id: string } } }>(
      async (c, next) => {
        const userId = c.req.header("x-test-user")
        if (!userId) throw new HTTPException(401)
        c.set("user", { id: userId })
        await next()
      }
    ),
  }
})

const baseId = "10000000-0000-4000-8000-000000000001"
const documentId = "20000000-0000-4000-8000-000000000001"
const chunk = (chunkId: string) => ({
  chunkId,
  documentId,
  knowledgeBaseId: baseId,
  documentTitle: "当前标题",
  contentRevision: 4,
  chunkIndex: 0,
  content: "数据库中的正文",
  metadata: { headingPath: ["上传"], startOffset: 10, endOffset: 20 },
})
let vectorCandidates: { chunkId: string; score: number }[]
let currentChunks: ReturnType<typeof chunk>[]

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  reranker.rerankChunks.mockResolvedValue(null)
  vectorCandidates = [
    { chunkId: "a", score: 0.95 },
    { chunkId: "b", score: 0.8 },
  ]
  currentChunks = [chunk("a"), chunk("b"), chunk("c")]
  db.knowledgeBase.findFirst.mockResolvedValue({ id: baseId })
  db.knowledgeDocument.findFirst.mockResolvedValue({ id: documentId })
  db.$queryRaw.mockImplementation((sql: Prisma.Sql) => {
    if (sql.text.includes("eligible_chunks")) return vectorCandidates
    if (sql.text.includes('AS "documentTitle"')) return currentChunks
    if (sql.text.includes('AS "chunkId"'))
      return currentChunks.map(({ chunkId }) => ({ chunkId }))
    return [{ id: documentId, contentRevision: 4 }]
  })
  embedding.embedQuery.mockResolvedValue({
    embeddingModel: "text-embedding-v4",
    embedding: Array(1024).fill(0.1),
  })
  es.searchKeywordChunks.mockResolvedValue([
    { chunkId: "b", score: 100 },
    { chunkId: "c", score: 80 },
  ])
})
afterEach(() => vi.restoreAllMocks())
const input = (value: Record<string, unknown> = {}) =>
  searchKnowledgeSchema.parse({ query: "如何上传？", ...value })

describe("knowledge retrieval", () => {
  it("normalizes the request once before both recall channels", async () => {
    await searchKnowledge(
      "owner",
      input({ query: "\uFEFF上传\r\n文件\u0000 " })
    )
    expect(embedding.embedQuery).toHaveBeenCalledWith("上传\n文件", undefined)
    expect(es.searchKeywordChunks).toHaveBeenCalledWith(
      expect.objectContaining({ query: "上传\n文件" })
    )
  })
  it("ranks a shared chunk first using RRF, rather than adding incompatible scores", async () => {
    const { items: result, warnings } = await searchKnowledge("owner", input())
    expect(warnings).toEqual([])
    expect(result.map((item) => item.chunkId)).toEqual(["b", "a", "c"])
    expect(result[0]).toMatchObject({
      ...chunk("b"),
      vectorRank: 2,
      keywordRank: 1,
      vectorScore: 0.8,
      keywordScore: 100,
    })
    expect(result[0].score).toBeCloseTo(1 / 62 + 1 / 61)
    expect(result[1].score).toBeCloseTo(1 / 61)
  })
  it("allows validating vector recall without calling ES", async () => {
    const { items: result } = await searchKnowledge(
      "owner",
      input({ mode: "vector", limit: 1 })
    )
    expect(result.map((item) => item.chunkId)).toEqual(["a"])
    expect(result[0]).toMatchObject({ keywordRank: null, vectorScore: 0.95 })
    expect(es.searchKeywordChunks).not.toHaveBeenCalled()
  })
  it("searches ready documents across all owned knowledge bases when no resource scope is specified", async () => {
    const otherDocumentId = "20000000-0000-4000-8000-000000000002"
    const otherBaseId = "10000000-0000-4000-8000-000000000002"
    currentChunks = [
      chunk("a"),
      {
        ...chunk("b"),
        documentId: otherDocumentId,
        knowledgeBaseId: otherBaseId,
      },
    ]
    db.$queryRaw.mockImplementation((sql: Prisma.Sql) => {
      if (sql.text.includes("eligible_chunks")) return vectorCandidates
      if (sql.text.includes('AS "documentTitle"')) return currentChunks
      return [
        { id: documentId, contentRevision: 4 },
        { id: otherDocumentId, contentRevision: 4 },
      ]
    })
    const { items } = await searchKnowledge("owner", input())
    expect(new Set(items.map((item) => item.documentId))).toEqual(
      new Set([documentId, otherDocumentId])
    )
    expect(new Set(items.map((item) => item.knowledgeBaseId))).toEqual(
      new Set([baseId, otherBaseId])
    )
    expect(db.knowledgeBase.findFirst).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.findFirst).not.toHaveBeenCalled()
    expect(es.searchKeywordChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        documentVersions: [`${documentId}:4`, `${otherDocumentId}:4`],
      })
    )
    for (const [sql] of db.$queryRaw.mock.calls) {
      expect(sql.values).toContain("owner")
      expect(sql.values).not.toContain(baseId)
      expect(sql.values).not.toContain(otherBaseId)
      expect(sql.values).not.toContain(documentId)
      expect(sql.values).not.toContain(otherDocumentId)
    }
  })
  it("allows keyword-only matches when the vector channel has no hits", async () => {
    vectorCandidates = []
    expect(
      (await searchKnowledge("owner", input())).items.map(
        (item) => item.chunkId
      )
    ).toEqual(["b", "c"])
  })
  it("allows vector matches when ES has no keyword matches", async () => {
    es.searchKeywordChunks.mockResolvedValue([])
    expect(
      (await searchKnowledge("owner", input())).items.map(
        (item) => item.chunkId
      )
    ).toEqual(["a", "b"])
  })
  it("filters stale, deleted or foreign ES/vector hits through current PG rows", async () => {
    currentChunks = [chunk("b")]
    const { items: result } = await searchKnowledge("owner", input())
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      ...chunk("b"),
      vectorRank: 1,
      keywordRank: 1,
    })
    expect(result[0].score).toBeCloseTo(2 / 61)
  })
  it("returns no stale content if all documents change or disappear during recall", async () => {
    currentChunks = []
    expect(await searchKnowledge("owner", input())).toEqual({
      items: [],
      warnings: [],
    })
    expect(reranker.rerankChunks).not.toHaveBeenCalled()
  })
  it("restricts ES recall to owned, ready body versions before ranking", async () => {
    await searchKnowledge(
      "owner",
      input({ knowledgeBaseId: baseId, documentId })
    )
    expect(db.knowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: {
        id: documentId,
        knowledgeBaseId: baseId,
        deletedAt: null,
        knowledgeBase: { userId: "owner", deletedAt: null },
      },
      select: { id: true },
    })
    expect(es.searchKeywordChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        documentVersions: [`${documentId}:4`],
        limit: 20,
      })
    )
    const queries: Prisma.Sql[] = db.$queryRaw.mock.calls.map(([sql]) => sql)
    for (const sql of queries) {
      expect(sql.values).toEqual(
        expect.arrayContaining(["owner", baseId, documentId])
      )
      expect(sql.text).toContain(
        'd."chunkedContentRevision" = d."contentRevision"'
      )
      expect(sql.text).toContain("d.\"chunkStatus\" = 'READY'")
      expect(sql.text).toContain('k."deletedAt" IS NULL')
      expect(sql.text).toContain('d."deletedAt" IS NULL')
    }
    expect(queries[1].text).toContain(
      'c."contentRevision" = d."contentRevision"'
    )
    expect(queries[1].text).toContain('c."embeddingModel" =')
    expect(queries[1].values).toContain("text-embedding-v4")
    expect(queries[1].text).toContain("::vector(1024)")
    expect(queries[1].text).toContain("<=>")
  })
  it.each(["base", "document"])(
    "rejects inaccessible %s before any third-party request",
    async (resource) => {
      if (resource === "base")
        db.knowledgeBase.findFirst.mockResolvedValue(null)
      else db.knowledgeDocument.findFirst.mockResolvedValue(null)
      await expect(
        searchKnowledge(
          "owner",
          input(
            resource === "base" ? { knowledgeBaseId: baseId } : { documentId }
          )
        )
      ).rejects.toMatchObject({ status: 404 })
      expect(db.$queryRaw).not.toHaveBeenCalled()
      expect(embedding.embedQuery).not.toHaveBeenCalled()
      expect(es.searchKeywordChunks).not.toHaveBeenCalled()
    }
  )
  it("does not spend embedding requests when no index is ready", async () => {
    db.$queryRaw.mockResolvedValue([])
    expect(await searchKnowledge("owner", input())).toEqual({
      items: [],
      warnings: [],
    })
    expect(embedding.embedQuery).not.toHaveBeenCalled()
    expect(es.searchKeywordChunks).not.toHaveBeenCalled()
  })
  it("does not hydrate rows when both channels are empty", async () => {
    vectorCandidates = []
    es.searchKeywordChunks.mockResolvedValue([])
    expect(await searchKnowledge("owner", input())).toEqual({
      items: [],
      warnings: [],
    })
    expect(db.$queryRaw).toHaveBeenCalledTimes(2)
    expect(reranker.rerankChunks).not.toHaveBeenCalled()
  })
  it("falls back to keywords with a visible warning when query embedding fails", async () => {
    embedding.embedQuery.mockRejectedValue(new Error("Embedding unavailable"))
    const { items, warnings } = await searchKnowledge("owner", input())
    expect(items.map((item) => item.chunkId)).toEqual(["b", "c"])
    expect(items.every((item) => item.vectorScore === null)).toBe(true)
    expect(warnings).toEqual([
      { stage: "embedding", message: "问题向量生成失败，本次仅使用关键词检索" },
    ])
    expect(
      db.$queryRaw.mock.calls.some(([sql]) =>
        sql.text.includes("eligible_chunks")
      )
    ).toBe(false)
    expect(console.warn).toHaveBeenCalled()
  })
  it("retains the degradation warning even if keyword recall has no hits", async () => {
    embedding.embedQuery.mockRejectedValue(new Error("Embedding unavailable"))
    es.searchKeywordChunks.mockResolvedValue([])
    const result = await searchKnowledge("owner", input())
    expect(result.items).toEqual([])
    expect(result.warnings[0].stage).toBe("embedding")
    expect(reranker.rerankChunks).not.toHaveBeenCalled()
  })
  it("still fails for embedding errors in vector-only mode", async () => {
    const error = new Error("Embedding unavailable")
    embedding.embedQuery.mockRejectedValue(error)
    await expect(
      searchKnowledge("owner", input({ mode: "vector" }))
    ).rejects.toBe(error)
    expect(es.searchKeywordChunks).not.toHaveBeenCalled()
  })
  it.each(["ES", "vector database"])(
    "does not downgrade %s errors",
    async (source) => {
      const error = new Error(`${source} unavailable`)
      if (source === "ES") es.searchKeywordChunks.mockRejectedValue(error)
      else
        db.$queryRaw.mockImplementation((sql: Prisma.Sql) => {
          if (sql.text.includes("eligible_chunks")) throw error
          return [{ id: documentId, contentRevision: 4 }]
        })
      await expect(searchKnowledge("owner", input())).rejects.toBe(error)
      expect(reranker.rerankChunks).not.toHaveBeenCalled()
    }
  )
  it("reranks all fused candidates before applying the final limit", async () => {
    reranker.rerankChunks.mockResolvedValue([
      { index: 2, score: 0.95 },
      { index: 0, score: 0.7 },
    ])
    const { items, warnings } = await searchKnowledge(
      "owner",
      input({ limit: 1 })
    )
    expect(items.map((item) => item.chunkId)).toEqual(["c"])
    expect(items[0]).toMatchObject({ ...chunk("c"), rerankScore: 0.95 })
    expect(items[0].score).toBeCloseTo(1 / 62)
    expect(warnings).toEqual([])
    expect(reranker.rerankChunks).toHaveBeenCalledWith({
      query: "如何上传？",
      chunks: [
        expect.objectContaining({ chunkId: "b" }),
        expect.objectContaining({ chunkId: "a" }),
        expect.objectContaining({ chunkId: "c" }),
      ],
      abortSignal: undefined,
    })
  })
  it("returns an empty list when successful reranking filters out every candidate", async () => {
    reranker.rerankChunks.mockResolvedValue([])
    expect(await searchKnowledge("owner", input())).toEqual({
      items: [],
      warnings: [],
    })
  })
  it("falls back to RRF without applying a rerank score threshold on reranker failure", async () => {
    reranker.rerankChunks.mockRejectedValue(new Error("HTTP 429"))
    const { items, warnings } = await searchKnowledge(
      "owner",
      input({ limit: 2 })
    )
    expect(items.map((item) => item.chunkId)).toEqual(["b", "a"])
    expect(items.every((item) => item.rerankScore === null)).toBe(true)
    expect(warnings).toEqual([
      { stage: "rerank", message: "重排失败，本次使用 RRF 排序" },
    ])
  })
  it.each(["success", "failure"])(
    "excludes documents deleted or reindexed during reranking (%s)",
    async (outcome) => {
      reranker.rerankChunks.mockImplementation(async () => {
        currentChunks = [chunk("a"), chunk("c")]
        if (outcome === "failure") throw new Error("timeout")
        return [
          { index: 0, score: 0.9 },
          { index: 1, score: 0.8 },
          { index: 2, score: 0.7 },
        ]
      })
      const { items } = await searchKnowledge("owner", input({ limit: 1 }))
      expect(items.map((item) => item.chunkId)).toEqual(["a"])
      const sql: Prisma.Sql = db.$queryRaw.mock.calls.at(-1)?.[0]
      expect(sql.text).toContain('c."contentRevision" = d."contentRevision"')
      expect(sql.text).toContain(
        'd."chunkedContentRevision" = d."contentRevision"'
      )
      expect(sql.values).toContain("owner")
    }
  )
  it("does not hide a database failure during post-rerank validation", async () => {
    reranker.rerankChunks.mockResolvedValue([{ index: 0, score: 0.9 }])
    const error = new Error("database unavailable")
    const read = db.$queryRaw.getMockImplementation()
    db.$queryRaw.mockImplementation((sql: Prisma.Sql) => {
      if (
        !sql.text.includes("eligible_chunks") &&
        sql.text.includes('AS "chunkId"')
      )
        throw error
      return read?.(sql)
    })
    await expect(searchKnowledge("owner", input())).rejects.toBe(error)
  })
  it.each(["embedding", "rerank"])(
    "propagates caller cancellation during %s instead of degrading",
    async (stage) => {
      const controller = new AbortController()
      const error = new Error("用户已取消")
      const mock =
        stage === "embedding" ? embedding.embedQuery : reranker.rerankChunks
      mock.mockImplementation(async () => {
        controller.abort(error)
        throw error
      })
      await expect(
        searchKnowledge("owner", input(), controller.signal)
      ).rejects.toBe(error)
      expect(console.warn).not.toHaveBeenCalled()
    }
  )
})

describe("knowledge search HTTP boundary", () => {
  const app = new Hono().route("/search", knowledgeSearchRoute)
  const request = (body: unknown, authenticated = true) =>
    app.request("/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { "x-test-user": "owner" } : {}),
      },
      body: JSON.stringify(body),
    })
  it("accepts a logged-in search and applies defaults", async () => {
    const response = await request({ query: "如何上传？" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      items: [{ chunkId: "b" }, { chunkId: "a" }, { chunkId: "c" }],
      warnings: [],
    })
  })
  it("exposes partial success warnings at the HTTP boundary", async () => {
    embedding.embedQuery.mockRejectedValue(new Error("embedding unavailable"))
    reranker.rerankChunks.mockRejectedValue(new Error("rerank unavailable"))
    const response = await request({ query: "上传" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      items: [{ chunkId: "b" }, { chunkId: "c" }],
      warnings: [{ stage: "embedding" }, { stage: "rerank" }],
    })
  })
  it("rejects unauthenticated requests without touching the index", async () => {
    expect((await request({ query: "上传" }, false)).status).toBe(401)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })
  it.each([
    { query: " " },
    { query: "\u0000\u0001" },
    { query: "x", limit: 21 },
    { query: "x", limit: 0 },
    { query: "x", limit: 1.5 },
    { query: "x", mode: "keyword" },
    { query: "x", userId: "another-user" },
    { query: "x", knowledgeBaseId: "invalid" },
  ])("rejects invalid or spoofed input: %j", async (body) => {
    expect((await request(body)).status).toBe(400)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })
})
