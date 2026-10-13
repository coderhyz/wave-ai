import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  DocumentProcessingJob,
  KnowledgeDocument,
  Prisma,
} from "@/app/generated/prisma"
import { EMBEDDING_MODEL } from "@/lib/knowledge/indexing/embedding"
import { processNextDocumentJob } from "@/lib/knowledge/jobs/processor"
import { registerRechunkJob } from "@/lib/knowledge/management/service"

const { db, embedding, es } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    knowledgeBase: { findFirst: vi.fn() },
    knowledgeDocument: { findFirst: vi.fn(), updateMany: vi.fn() },
    documentProcessingJob: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
    },
    documentChunk: { deleteMany: vi.fn() },
  },
  embedding: { embedDocumentChunks: vi.fn() },
  es: { indexKnowledgeChunks: vi.fn() },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/es/knowledge-index", () => es)
vi.mock("@/lib/knowledge/indexing/embedding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/knowledge/indexing/embedding")
  >()),
  ...embedding,
}))

type IndexedDocument = Pick<
  KnowledgeDocument,
  | "id"
  | "knowledgeBaseId"
  | "title"
  | "status"
  | "contentRevision"
  | "markdownContent"
  | "parseMetadata"
  | "chunkStatus"
  | "chunkErrorMessage"
  | "chunkedContentRevision"
  | "deletedAt"
> & { knowledgeBase: { userId: string; deletedAt: Date | null } }
type Job = Pick<
  DocumentProcessingJob,
  | "id"
  | "documentId"
  | "type"
  | "status"
  | "payload"
  | "attempts"
  | "maxAttempts"
  | "targetRevision"
  | "lockedUntil"
  | "lockToken"
  | "availableAt"
>
let document: IndexedDocument
let job: Job
let rows: { contentRevision: number; content: string; embeddingModel: string }[]

function matchesJob(where: Prisma.DocumentProcessingJobWhereInput) {
  if (where.id && where.id !== job.id) return false
  if (where.documentId && where.documentId !== job.documentId) return false
  if (where.type && where.type !== job.type) return false
  if (where.lockToken && where.lockToken !== job.lockToken) return false
  if (typeof where.status === "string" && where.status !== job.status)
    return false
  if (
    typeof where.status === "object" &&
    Array.isArray(where.status.in) &&
    !where.status.in.includes(job.status)
  )
    return false
  if (
    where.lockedUntil instanceof Date &&
    where.lockedUntil.getTime() !== job.lockedUntil?.getTime()
  )
    return false
  if (where.lockedUntil === null && job.lockedUntil !== null) return false
  if (
    where.lockedUntil &&
    typeof where.lockedUntil === "object" &&
    "gt" in where.lockedUntil
  ) {
    const deadline = where.lockedUntil.gt
    if (
      (deadline instanceof Date || typeof deadline === "string") &&
      (!job.lockedUntil || job.lockedUntil <= new Date(deadline))
    )
      return false
  }
  if (
    typeof where.targetRevision === "object" &&
    typeof where.targetRevision?.lt === "number"
  ) {
    if (
      job.targetRevision === null ||
      job.targetRevision >= where.targetRevision.lt
    )
      return false
  }
  return true
}

function matchesDocument(where: Prisma.KnowledgeDocumentWhereInput) {
  return (
    (!where.id || where.id === document.id) &&
    (!Object.hasOwn(where, "deletedAt") ||
      document.deletedAt === where.deletedAt) &&
    (!where.knowledgeBase || document.knowledgeBase.deletedAt === null) &&
    (where.contentRevision === undefined ||
      document.contentRevision === where.contentRevision) &&
    (!where.status || document.status === where.status)
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  es.indexKnowledgeChunks.mockResolvedValue(undefined)
  vi.spyOn(console, "error").mockImplementation(() => {})
  document = {
    id: "document-id",
    knowledgeBaseId: "base-id",
    title: "手册",
    status: "READY",
    contentRevision: 4,
    markdownContent: "# 上传\n\n选择文件",
    parseMetadata: null,
    chunkStatus: "PENDING",
    chunkErrorMessage: null,
    chunkedContentRevision: null,
    deletedAt: null,
    knowledgeBase: { userId: "owner", deletedAt: null },
  }
  job = {
    id: "job-id",
    documentId: document.id,
    type: "RECHUNK",
    status: "PENDING",
    payload: {},
    attempts: 0,
    maxAttempts: 3,
    targetRevision: 4,
    lockedUntil: null,
    lockToken: null,
    availableAt: new Date(0),
  }
  rows = [
    { contentRevision: 3, content: "旧索引", embeddingModel: EMBEDDING_MODEL },
  ]
  // 模拟事务回滚与条件写入，验证失败后保存的状态，而不只是检查调用次数。
  db.$transaction.mockImplementation(async (callback) => {
    const previous = structuredClone({ document, job, rows })
    try {
      return await callback(db)
    } catch (error) {
      document = previous.document
      job = previous.job
      rows = previous.rows
      throw error
    }
  })
  db.knowledgeBase.findFirst.mockImplementation(() =>
    document.knowledgeBase.deletedAt ? null : { id: document.knowledgeBaseId }
  )
  db.knowledgeDocument.findFirst.mockImplementation(
    ({ where }: Prisma.KnowledgeDocumentFindFirstArgs) =>
      matchesDocument(where ?? {}) ? structuredClone(document) : null
  )
  db.knowledgeDocument.updateMany.mockImplementation(
    ({ where, data }: Prisma.KnowledgeDocumentUpdateManyArgs) => {
      if (!matchesDocument(where ?? {})) return { count: 0 }
      Object.assign(document, data)
      return { count: 1 }
    }
  )
  db.documentProcessingJob.findFirst.mockImplementation(() => {
    const now = new Date()
    return (job.status === "PENDING" && job.availableAt <= now) ||
      (job.status === "RUNNING" && job.lockedUntil && job.lockedUntil < now)
      ? structuredClone(job)
      : null
  })
  db.documentProcessingJob.updateMany.mockImplementation(
    ({ where, data }: Prisma.DocumentProcessingJobUpdateManyArgs) => {
      if (!matchesJob(where ?? {})) return { count: 0 }
      const { attempts, ...remaining } = data
      Object.assign(job, remaining)
      if (typeof attempts === "object") job.attempts += attempts.increment ?? 0
      return { count: 1 }
    }
  )
  db.documentChunk.deleteMany.mockImplementation(() => {
    const count = rows.length
    rows = []
    return { count }
  })
  db.$executeRaw.mockImplementation((sql: Prisma.Sql) => {
    expect(sql.text).toContain('INSERT INTO "document_chunks"')
    expect(sql.text).toContain("::vector(1024)")
    for (let offset = 0; offset < sql.values.length; offset += 8) {
      rows.push({
        contentRevision: Number(sql.values[offset + 2]),
        content: String(sql.values[offset + 4]),
        embeddingModel: String(sql.values[offset + 7]),
      })
    }
    return sql.values.length / 8
  })
  embedding.embedDocumentChunks.mockImplementation(async ({ chunks }) => {
    expect(document.chunkStatus).toBe("RUNNING")
    expect(document.status).toBe("READY")
    return {
      embeddingModel: EMBEDDING_MODEL,
      embeddings: chunks.map(() => Array<number>(1024).fill(0.1)),
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("RECHUNK indexing", () => {

  it("finishes indexing when remote database round trips exceed ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    db.$transaction.mockImplementationOnce(
      async (callback, options: { timeout: number }) => {
        const started = Date.now()
        db.knowledgeDocument.findFirst.mockImplementationOnce(
          ({ where }: Prisma.KnowledgeDocumentFindFirstArgs) => {
            vi.setSystemTime(started + 10_345)
            if (Date.now() - started > options.timeout) {
              throw new Error("Transaction expired before reading the document")
            }
            return matchesDocument(where ?? {})
              ? structuredClone(document)
              : null
          }
        )
        return callback(db)
      }
    )
    await processNextDocumentJob()
    expect(job.status).toBe("SUCCEEDED")
    expect(document.chunkStatus).toBe("READY")
    expect(rows.every((row) => row.contentRevision === 4)).toBe(true)
  })

  it("writes ES before committing PG and shares the same chunk ID", async () => {
    await processNextDocumentJob()
    const params = es.indexKnowledgeChunks.mock.calls[0][0]
    expect(params).toMatchObject({
      userId: "owner",
      knowledgeBaseId: "base-id",
      documentId: document.id,
      contentRevision: 4,
    })
    expect(es.indexKnowledgeChunks.mock.invocationCallOrder[0]).toBeLessThan(
      db.$executeRaw.mock.invocationCallOrder[0]
    )
    const { getKnowledgeChunkId } =
      await import("@/lib/knowledge/indexing/chunk")
    const sql: Prisma.Sql = db.$executeRaw.mock.calls[0][0]
    expect(sql.values[0]).toBe(
      getKnowledgeChunkId(document.id, 4, params.chunks[0].chunkIndex)
    )
  })

  it("keeps the old PG index and retries when ES partially fails", async () => {
    es.indexKnowledgeChunks.mockRejectedValue(new Error("ES bulk failed"))
    await processNextDocumentJob()
    expect(rows[0].contentRevision).toBe(3)
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
    expect(job.status).toBe("PENDING")
    expect(document).toMatchObject({
      status: "READY",
      chunkStatus: "PENDING",
      chunkErrorMessage: "ES bulk failed",
    })
  })

  it("does not commit a version edited during ES indexing", async () => {
    es.indexKnowledgeChunks.mockImplementation(async () => {
      document.contentRevision = 5
    })
    await processNextDocumentJob()
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
    expect(job.status).toBe("CANCELLED")
    expect(rows[0].contentRevision).toBe(3)
  })
  it("indexes chunks and marks the same body revision ready in one transaction", async () => {
    await expect(processNextDocumentJob()).resolves.toBe(true)
    expect(job.status).toBe("SUCCEEDED")
    expect(job.lockToken).toBeNull()
    expect(document).toMatchObject({
      status: "READY",
      contentRevision: 4,
      chunkStatus: "READY",
      chunkedContentRevision: 4,
      chunkErrorMessage: null,
    })
    expect(rows).toEqual([
      {
        contentRevision: 4,
        content: document.markdownContent,
        embeddingModel: EMBEDDING_MODEL,
      },
    ])
    expect(db.documentProcessingJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { in: ["PARSE", "REPARSE", "RECHUNK", "CLEANUP"] },
        }),
      })
    )
    const sql: Prisma.Sql = db.$executeRaw.mock.calls[0][0]
    expect(JSON.parse(String(sql.values[5]))).toMatchObject({
      headingPath: ["上传"],
      startOffset: 0,
      endOffset: document.markdownContent?.length,
    })
    expect(String(sql.values[6]).split(",")).toHaveLength(1024)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    await expect(processNextDocumentJob()).resolves.toBe(false)
    expect(db.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it("persists an empty body as a ready index with zero chunks", async () => {
    document.markdownContent = ""
    await processNextDocumentJob()
    expect(rows).toEqual([])
    expect(db.$executeRaw).not.toHaveBeenCalled()
    expect(document.chunkedContentRevision).toBe(4)
    expect(job.status).toBe("SUCCEEDED")
  })

  it("does not process a task when another worker wins its claim", async () => {
    db.documentProcessingJob.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(processNextDocumentJob()).resolves.toBe(false)
    expect(embedding.embedDocumentChunks).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it("takes over an expired task and completes its index", async () => {
    job.status = "RUNNING"
    job.lockToken = "expired-worker"
    job.lockedUntil = new Date(Date.now() - 1000)
    await processNextDocumentJob()
    expect(job.status).toBe("SUCCEEDED")
    expect(document.chunkedContentRevision).toBe(4)
  })

  it("preserves paragraph and page locators saved by the parser", async () => {
    document.markdownContent = "正文"
    document.parseMetadata = {
      sections: [
        { startOffset: 0, endOffset: 2, locator: { paragraph: 1, page: 2 } },
      ],
    }
    await processNextDocumentJob()
    const sql: Prisma.Sql = db.$executeRaw.mock.calls[0][0]
    expect(JSON.parse(String(sql.values[5]))).toMatchObject({
      paragraph: 1,
      page: 2,
    })
  })

  it("writes more than 100 chunks in bounded SQL batches", async () => {
    document.markdownContent = Array.from(
      { length: 105 },
      (_, index) => `# 第 ${index} 节\n\n正文 ${index}`
    ).join("\n\n")
    await processNextDocumentJob()
    expect(rows).toHaveLength(105)
    expect(
      db.$executeRaw.mock.calls.map(([query]) => {
        const sql: Prisma.Sql = query
        return sql.values.length
      })
    ).toEqual([800, 40])
    expect(document.chunkedContentRevision).toBe(4)
    expect(job.status).toBe("SUCCEEDED")
  })

  it("binds document content as SQL parameters", async () => {
    document.markdownContent = "'); DROP TABLE document_chunks; --"
    await processNextDocumentJob()
    const sql: Prisma.Sql = db.$executeRaw.mock.calls[0][0]
    expect(sql.text).not.toContain("DROP TABLE")
    expect(sql.values).toContain(document.markdownContent)
  })

  it("does not mark the body running if its claim is lost before processing", async () => {
    db.$queryRaw.mockImplementationOnce(() => {
      job.lockToken = "new-worker-token"
    })
    await processNextDocumentJob()
    expect(embedding.embedDocumentChunks).not.toHaveBeenCalled()
    expect(document.chunkStatus).toBe("PENDING")
  })

  it("skips an obsolete version before paying for embeddings", async () => {
    document.contentRevision = 5
    await processNextDocumentJob()
    expect(job.status).toBe("CANCELLED")
    expect(embedding.embedDocumentChunks).not.toHaveBeenCalled()
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
    expect(document.chunkStatus).toBe("PENDING")
  })

  it.each(["document", "knowledgeBase"])(
    "skips a deleted %s",
    async (target) => {
      if (target === "document") document.deletedAt = new Date()
      else document.knowledgeBase.deletedAt = new Date()
      await processNextDocumentJob()
      expect(job.status).toBe("CANCELLED")
      expect(embedding.embedDocumentChunks).not.toHaveBeenCalled()
    }
  )

  it("does not commit after the body changes during embedding", async () => {
    embedding.embedDocumentChunks.mockImplementationOnce(async ({ chunks }) => {
      document.contentRevision = 5
      document.markdownContent = "新正文"
      document.chunkStatus = "PENDING"
      return {
        embeddingModel: EMBEDDING_MODEL,
        embeddings: chunks.map(() => [0.1]),
      }
    })
    await processNextDocumentJob()
    expect(job.status).toBe("CANCELLED")
    expect(job.lockToken).toBeNull()
    expect(document).toMatchObject({
      contentRevision: 5,
      chunkStatus: "PENDING",
      chunkedContentRevision: null,
    })
    expect(rows[0].content).toBe("旧索引")
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("does not commit after the document is deleted during embedding", async () => {
    embedding.embedDocumentChunks.mockImplementationOnce(async () => {
      document.deletedAt = new Date()
      job.status = "CANCELLED"
      job.lockToken = null
      return { embeddingModel: EMBEDDING_MODEL, embeddings: [[0.1]] }
    })
    await processNextDocumentJob()
    expect(job.status).toBe("CANCELLED")
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
  })

  it("does not recreate chunks after the base, document and processing task are physically deleted", async () => {
    embedding.embedDocumentChunks.mockImplementationOnce(async () => {
      rows = []
      db.knowledgeBase.findFirst.mockResolvedValue(null)
      db.knowledgeDocument.findFirst.mockResolvedValue(null)
      db.documentProcessingJob.updateMany.mockResolvedValue({ count: 0 })
      return { embeddingModel: EMBEDDING_MODEL, embeddings: [[0.1]] }
    })
    await processNextDocumentJob()
    expect(rows).toEqual([])
    expect(db.$executeRaw).not.toHaveBeenCalled()
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
  })

  it("discards results after another worker takes over the lease", async () => {
    embedding.embedDocumentChunks.mockImplementationOnce(async () => {
      job.lockToken = "new-worker-token"
      return { embeddingModel: EMBEDDING_MODEL, embeddings: [[0.1]] }
    })
    await processNextDocumentJob()
    expect(job.status).toBe("RUNNING")
    expect(job.lockToken).toBe("new-worker-token")
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
  })

  it("discards results when the lease expires before commit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    embedding.embedDocumentChunks.mockImplementationOnce(async () => {
      vi.setSystemTime(Number(job.lockedUntil) + 1)
      return { embeddingModel: EMBEDDING_MODEL, embeddings: [[0.1]] }
    })
    await processNextDocumentJob()
    expect(job.status).toBe("RUNNING")
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
  })

  it("rolls back all writes if the lease expires during insertion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    db.$executeRaw.mockImplementationOnce(() => {
      vi.setSystemTime(Number(job.lockedUntil) + 1)
      return 1
    })
    await processNextDocumentJob()
    expect(rows[0].content).toBe("旧索引")
    expect(document.chunkedContentRevision).toBeNull()
    expect(job.status).toBe("RUNNING")
  })

  it("rolls back an insert failure and retries without damaging the old index", async () => {
    db.$executeRaw.mockRejectedValueOnce(new Error("database insert failed"))
    await processNextDocumentJob()
    expect(rows[0].content).toBe("旧索引")
    expect(document).toMatchObject({
      status: "READY",
      chunkStatus: "PENDING",
      chunkedContentRevision: null,
      chunkErrorMessage: "database insert failed",
    })
    expect(job.status).toBe("PENDING")
    job.availableAt = new Date(0)
    await processNextDocumentJob()
    expect(rows).toHaveLength(1)
    expect(rows[0].contentRevision).toBe(4)
    expect(job.status).toBe("SUCCEEDED")
    expect(document.chunkErrorMessage).toBeNull()
  })

  it.each([0, 2])(
    "keeps the body readable when embedding fails at attempt %s",
    async (attempts) => {
      job.attempts = attempts
      embedding.embedDocumentChunks.mockRejectedValueOnce(
        new Error("QWEN_API_KEY is missing")
      )
      await processNextDocumentJob()
      expect(document).toMatchObject({
        status: "READY",
        chunkStatus: attempts === 0 ? "PENDING" : "FAILED",
        chunkErrorMessage: "QWEN_API_KEY is missing",
      })
      expect(job.status).toBe(attempts === 0 ? "PENDING" : "FAILED")
      const lockOrder = db.$queryRaw.mock.invocationCallOrder.at(-1)
      const failureUpdateOrder =
        db.documentProcessingJob.updateMany.mock.invocationCallOrder.at(-1)
      expect(lockOrder).toBeLessThan(Number(failureUpdateOrder))
      expect(rows[0].content).toBe("旧索引")
      expect(db.documentChunk.deleteMany).not.toHaveBeenCalled()
    }
  )

  it("does not overwrite a newer version's state when embedding fails", async () => {
    embedding.embedDocumentChunks.mockImplementationOnce(async () => {
      document.contentRevision = 5
      document.chunkStatus = "READY"
      document.chunkedContentRevision = 5
      throw new Error("old task failed")
    })
    await processNextDocumentJob()
    expect(document).toMatchObject({
      contentRevision: 5,
      chunkStatus: "READY",
      chunkedContentRevision: 5,
      chunkErrorMessage: null,
    })
  })

  it("does not overwrite another worker's state when the old attempt fails", async () => {
    embedding.embedDocumentChunks.mockImplementationOnce(async () => {
      job.lockToken = "new-worker-token"
      document.chunkStatus = "READY"
      document.chunkedContentRevision = 4
      throw new Error("old task failed")
    })
    await processNextDocumentJob()
    expect(job.lockToken).toBe("new-worker-token")
    expect(document.chunkStatus).toBe("READY")
    expect(document.chunkErrorMessage).toBeNull()
  })

  it("registers one task key per body version and cancels older work", async () => {
    job.status = "RUNNING"
    job.lockToken = "old-worker"
    const keys = new Set<string>()
    db.documentProcessingJob.createMany.mockImplementation(
      ({ data }: Prisma.DocumentProcessingJobCreateManyArgs) => {
        for (const item of Array.isArray(data) ? data : [data])
          keys.add(item.dedupeKey)
        return { count: 1 }
      }
    )
    const register = () =>
      db.$transaction((tx: Prisma.TransactionClient) =>
        registerRechunkJob(tx, {
          id: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          contentRevision: 5,
        })
      )
    await register()
    await register()
    expect(keys).toEqual(new Set(["rechunk:document-id:5"]))
    expect(db.documentProcessingJob.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
    expect(job.status).toBe("CANCELLED")
    expect(job.lockToken).toBeNull()
  })
})
