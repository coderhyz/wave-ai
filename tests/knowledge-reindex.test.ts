import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { db, es } = vi.hoisted(() => ({
  db: {
    $disconnect: vi.fn(),
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    knowledgeBase: { findFirst: vi.fn() },
    knowledgeDocument: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    documentProcessingJob: { updateMany: vi.fn(), createMany: vi.fn() },
  },
  es: { ensureKnowledgeChunkIndex: vi.fn() },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/es/knowledge-index", () => es)
const document = {
  id: "doc",
  knowledgeBaseId: "base",
  contentRevision: 4,
  knowledgeBase: { userId: "owner" },
}
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})
  es.ensureKnowledgeChunkIndex.mockResolvedValue(undefined)
  db.$transaction.mockImplementation((callback) => callback(db))
  db.knowledgeBase.findFirst.mockResolvedValue({ id: "base" })
  db.knowledgeDocument.findMany.mockResolvedValue([document])
  db.knowledgeDocument.findFirst.mockResolvedValue(document)
  db.documentProcessingJob.updateMany.mockResolvedValue({ count: 1 })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("existing document index backfill", () => {

  it("registers jobs when database round trips exceed Prisma's default transaction timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    db.$transaction.mockImplementation(
      async (callback, options?: { timeout: number }) => {
        const started = Date.now()
        const result = await callback(db)
        vi.setSystemTime(started + 6_000)
        if (Date.now() - started > (options?.timeout ?? 5_000)) {
          throw new Error("Transaction not found after its timeout")
        }
        return result
      }
    )
    await import("@/workers/reindex-documents")
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: { id: "doc", contentRevision: 4 },
      data: { chunkStatus: "PENDING", chunkErrorMessage: null },
    })
    expect(db.$disconnect).toHaveBeenCalledOnce()
  })

  it("reuses completed same-revision jobs and queues their current body under the base lock", async () => {
    await import("@/workers/reindex-documents")
    expect(
      es.ensureKnowledgeChunkIndex.mock.invocationCallOrder[0]
    ).toBeLessThan(db.knowledgeDocument.findMany.mock.invocationCallOrder[0])
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.documentProcessingJob.createMany.mock.invocationCallOrder[0]
    )
    expect(db.documentProcessingJob.updateMany).toHaveBeenCalledWith({
      where: {
        dedupeKey: "rechunk:doc:4",
        status: { in: ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] },
      },
      data: {
        status: "PENDING",
        attempts: 0,
        availableAt: expect.any(Date),
        lastError: null,
        lockToken: null,
        lockedAt: null,
        lockedUntil: null,
      },
    })
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: { id: "doc", contentRevision: 4 },
      data: { chunkStatus: "PENDING", chunkErrorMessage: null },
    })
    expect(db.$disconnect).toHaveBeenCalledOnce()
  })
  it("preserves an already-running same-version job and its document progress", async () => {
    db.documentProcessingJob.updateMany.mockImplementation(({ where }) => ({
      count: where.dedupeKey ? 0 : 1,
    }))
    await import("@/workers/reindex-documents")
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })
  it("skips a document deleted or no longer ready while waiting for its base lock", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue(null)
    await import("@/workers/reindex-documents")
    expect(db.documentProcessingJob.createMany).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })
  it("fails before database changes if ES is unavailable and still closes the database", async () => {
    es.ensureKnowledgeChunkIndex.mockRejectedValue(new Error("ES unavailable"))
    await expect(import("@/workers/reindex-documents")).rejects.toThrow(
      "ES unavailable"
    )
    expect(db.knowledgeDocument.findMany).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.$disconnect).toHaveBeenCalledOnce()
  })
})
