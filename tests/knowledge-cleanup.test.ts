import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@/app/generated/prisma"
import { cleanupKnowledgeResources } from "@/lib/knowledge/documents/cleanup"
import {
  deleteKnowledgeDocument,
  deleteKnowledgeFolder,
  deleteKnowledgeBase,
} from "@/lib/knowledge/management/service"
import { DOCUMENT_PROCESSING_TIMEOUT_MS } from "@/lib/knowledge/documents/timeouts"
import { KnowledgeError } from "@/lib/knowledge/errors"

const mocks = vi.hoisted(() => ({
  findDocument: vi.fn(),
  findDocuments: vi.fn(),
  deleteDocument: vi.fn(),
  deleteDocuments: vi.fn(),
  findFolders: vi.fn(),
  deleteFolders: vi.fn(),
  deleteBase: vi.fn(),
  findJobs: vi.fn(),
  createJobs: vi.fn(),
  updateJobs: vi.fn(),
  deleteJobs: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  ownedFolder: vi.fn(),
  removeOss: vi.fn(),
  removeEs: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({
  default: {
    knowledgeDocument: {
      findFirst: mocks.findDocument,
      findMany: mocks.findDocuments,
      delete: mocks.deleteDocument,
      deleteMany: mocks.deleteDocuments,
    },
    knowledgeFolder: {
      findMany: mocks.findFolders,
      deleteMany: mocks.deleteFolders,
    },
    knowledgeBase: { delete: mocks.deleteBase },
    documentProcessingJob: {
      findMany: mocks.findJobs,
      createMany: mocks.createJobs,
      updateMany: mocks.updateJobs,
      deleteMany: mocks.deleteJobs,
    },
    $transaction: mocks.transaction,
    $disconnect: mocks.disconnect,
  },
}))
vi.mock("@/lib/knowledge/ownership", () => ({
  lockOwnedKnowledgeBase: mocks.lock,
  requireOwnedKnowledgeFolder: mocks.ownedFolder,
}))
vi.mock("@/lib/storage/oss", () => ({ deleteOssObject: mocks.removeOss }))
vi.mock("@/lib/es/knowledge-index", () => ({
  deleteKnowledgeChunks: mocks.removeEs,
}))

type Job = {
  id: string
  documentId: string | null
  knowledgeBaseId: string | null
  type: string
  status: string
  dedupeKey: string
  payload: Prisma.JsonValue
  availableAt: Date
  lockToken: string | null
  lockedUntil: Date | null
  attempts: number
  lastError: string | null
}
let jobs: Job[] = []
let removed = false
let inTransaction = false
let busy = false
let document: ReturnType<typeof sourceDocument>
const assetName = "00000000-0000-0000-0000-000000000000-0001.png"
function sourceDocument() {
  return {
    id: "doc",
    knowledgeBaseId: "base",
    storageKey: "original",
    checksumSha256: "hash",
    parseMetadata: { assetNames: [assetName] },
    status: "READY",
    chunkStatus: "READY",
    updatedAt: new Date(),
  }
}
const db = {
  knowledgeDocument: {
    findFirst: mocks.findDocument,
    findMany: mocks.findDocuments,
    delete: mocks.deleteDocument,
    deleteMany: mocks.deleteDocuments,
  },
  knowledgeFolder: {
    findMany: mocks.findFolders,
    deleteMany: mocks.deleteFolders,
  },
  knowledgeBase: { delete: mocks.deleteBase },
  documentProcessingJob: {
    findMany: mocks.findJobs,
    createMany: mocks.createJobs,
    updateMany: mocks.updateJobs,
    deleteMany: mocks.deleteJobs,
  },
}
function matches(
  job: Job,
  where: {
    id?: string
    status?: string
    lockToken?: string | null
    lockedUntil?: Date | null
    documentId?: string | { in: string[] }
    knowledgeBaseId?: string
    type?: { not: string }
  }
) {
  return (
    (!where.id || where.id === job.id) &&
    (!where.status || where.status === job.status) &&
    (where.lockToken === undefined || where.lockToken === job.lockToken) &&
    (where.lockedUntil === undefined ||
      where.lockedUntil?.getTime() === job.lockedUntil?.getTime()) &&
    (!where.documentId ||
      (typeof where.documentId === "string"
        ? where.documentId === job.documentId
        : where.documentId.in.includes(job.documentId ?? ""))) &&
    (!where.knowledgeBaseId || where.knowledgeBaseId === job.knowledgeBaseId) &&
    (!where.type || where.type.not !== job.type)
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  jobs = []
  removed = false
  inTransaction = false
  busy = false
  document = sourceDocument()
  vi.spyOn(console, "error").mockImplementation(() => {})
  mocks.lock.mockReset().mockImplementation(async (_db, userId) => {
    if (userId !== "owner")
      throw new KnowledgeError("KNOWLEDGE_BASE_NOT_FOUND", "Not found", 404)
  })
  mocks.ownedFolder.mockReset().mockImplementation(async (_db, userId) => {
    if (userId !== "owner")
      throw new KnowledgeError("KNOWLEDGE_FOLDER_NOT_FOUND", "Not found", 404)
    return { id: "folder", knowledgeBaseId: "base" }
  })
  mocks.findDocument.mockReset().mockImplementation(async ({ where }) => {
    if (typeof where.id === "object") return busy ? { id: "doc" } : null
    return removed || where.knowledgeBase?.userId !== "owner"
      ? null
      : { ...document }
  })
  mocks.findDocuments
    .mockReset()
    .mockImplementation(async () => (removed ? [] : [{ ...document }]))
  mocks.findFolders
    .mockReset()
    .mockImplementation(async ({ where }) =>
      where.parentId.in.includes("folder") ? [{ id: "child" }] : []
    )
  mocks.deleteDocument.mockReset().mockImplementation(async () => {
    removed = true
    jobs.forEach((job) => {
      job.documentId = null
    })
    return document
  })
  mocks.deleteDocuments.mockReset().mockImplementation(async () => {
    await mocks.deleteDocument()
    return { count: 1 }
  })
  mocks.deleteFolders.mockReset().mockResolvedValue({ count: 2 })
  mocks.deleteBase.mockReset().mockImplementation(async () => {
    jobs.forEach((job) => {
      job.knowledgeBaseId = null
    })
    return {}
  })
  mocks.createJobs.mockReset().mockImplementation(async ({ data }) => {
    for (const entry of data)
      if (!jobs.some((job) => job.dedupeKey === entry.dedupeKey))
        jobs.push({
          id: `job-${jobs.length}`,
          documentId: null,
          knowledgeBaseId: null,
          availableAt: new Date(),
          lockToken: null,
          lockedUntil: null,
          attempts: 0,
          lastError: null,
          ...entry,
        })
    return { count: data.length }
  })
  mocks.findJobs
    .mockReset()
    .mockImplementation(async ({ where }) =>
      jobs
        .filter(
          (job) =>
            job.type === "CLEANUP" &&
            where.status.in.includes(job.status) &&
            (!where.OR ||
              where.OR.some(
                (filter: { payload: { equals: string } }) =>
                  typeof job.payload === "object" &&
                  job.payload &&
                  "documentId" in job.payload &&
                  job.payload.documentId === filter.payload.equals
              ))
        )
        .map((job) => structuredClone(job))
    )
  mocks.updateJobs.mockReset().mockImplementation(async ({ where, data }) => {
    let count = 0
    for (const job of jobs)
      if (matches(job, where)) {
        Object.assign(job, data, {
          attempts: job.attempts + (data.attempts ? 1 : 0),
        })
        count++
      }
    return { count }
  })
  mocks.deleteJobs.mockReset().mockImplementation(async ({ where }) => {
    const before = jobs.length
    jobs = jobs.filter((job) => !matches(job, where))
    return { count: before - jobs.length }
  })
  mocks.transaction.mockReset().mockImplementation(async (execute) => {
    const snapshot = structuredClone({ jobs, removed })
    inTransaction = true
    try {
      return await execute(db)
    } catch (error) {
      jobs = snapshot.jobs
      removed = snapshot.removed
      throw error
    } finally {
      inTransaction = false
    }
  })
  mocks.removeOss.mockReset().mockImplementation(async () => {
    expect(inTransaction).toBe(false)
  })
  mocks.removeEs.mockReset().mockImplementation(async () => {
    expect(inTransaction).toBe(false)
  })
  mocks.disconnect.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

function addJob(overrides: Partial<Job> = {}) {
  const job: Job = {
    id: `job-${jobs.length}`,
    documentId: null,
    knowledgeBaseId: null,
    type: "CLEANUP",
    status: "PENDING",
    dedupeKey: `key-${jobs.length}`,
    payload: { documentId: "doc", storageKey: "source" },
    availableAt: new Date(),
    lockToken: null,
    lockedUntil: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  }
  jobs.push(job)
  return job
}

describe("delete and cleanup in the request", () => {
  it("commits the resource list before deleting OSS and ES, including after FK detachment", async () => {
    mocks.removeOss.mockImplementation(async () => {
      expect(removed).toBe(true)
      expect(inTransaction).toBe(false)
      expect(jobs.every((job) => job.documentId === null)).toBe(true)
    })
    const result = await deleteKnowledgeDocument("owner", "doc")
    expect(result.cleanup).toEqual({ completed: 3, failed: 0, pending: 0 })
    expect(mocks.removeOss).toHaveBeenCalledWith("original")
    expect(mocks.removeOss).toHaveBeenCalledWith(
      `knowledge-document-assets/doc/${assetName}`
    )
    expect(mocks.removeEs).toHaveBeenCalledWith("doc")
    expect(jobs).toHaveLength(0)
  })

  it("waits for remote deletion after committing the database transaction", async () => {
    const deleted = Promise.withResolvers<void>()
    mocks.removeOss.mockReturnValueOnce(deleted.promise)
    let settled = false
    const pending = deleteKnowledgeDocument("owner", "doc").then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(mocks.removeOss).toHaveBeenCalled())
    expect(removed).toBe(true)
    expect(inTransaction).toBe(false)
    expect(settled).toBe(false)
    expect(jobs).toHaveLength(3)
    deleted.resolve()
    expect((await pending).cleanup).toEqual({
      completed: 3,
      failed: 0,
      pending: 0,
    })
  })

  it.each(["oss", "es"])(
    "retains a durable failure after %s failure and retries on an explicit run",
    async (provider) => {
      const target = provider === "oss" ? mocks.removeOss : mocks.removeEs
      target.mockRejectedValueOnce(new Error("Provider unavailable"))
      const result = await deleteKnowledgeDocument("owner", "doc")
      expect(removed).toBe(true)
      expect(result.cleanup.failed).toBe(1)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        status: "FAILED",
        documentId: null,
        lastError: "Provider unavailable",
        lockToken: null,
      })
      expect(await cleanupKnowledgeResources()).toEqual({
        completed: 1,
        failed: 0,
        pending: 0,
      })
      expect(jobs).toHaveLength(0)
    }
  )
  it("rolls back resource records and never contacts providers when database deletion fails", async () => {
    mocks.deleteDocument.mockRejectedValueOnce(
      new Error("Database delete failed")
    )
    await expect(deleteKnowledgeDocument("owner", "doc")).rejects.toThrow(
      "Database delete failed"
    )
    expect(removed).toBe(false)
    expect(jobs).toHaveLength(0)
    expect(mocks.removeOss).not.toHaveBeenCalled()
    expect(mocks.removeEs).not.toHaveBeenCalled()
  })
  it.each(["document", "folder", "base"])(
    "rejects a busy %s deletion before recording or removing resources",
    async (kind) => {
      busy = true
      const pending =
        kind === "document"
          ? deleteKnowledgeDocument("owner", "doc")
          : kind === "folder"
            ? deleteKnowledgeFolder("owner", "folder", true)
            : deleteKnowledgeBase("owner", "base")
      await expect(pending).rejects.toMatchObject({
        code: "KNOWLEDGE_DOCUMENT_PROCESSING",
        status: 409,
      })
      expect(removed).toBe(false)
      expect(mocks.createJobs).not.toHaveBeenCalled()
      expect(mocks.removeOss).not.toHaveBeenCalled()
      expect(mocks.removeEs).not.toHaveBeenCalled()
      const guard = mocks.findDocument.mock.calls.find(
        ([args]) => typeof args.where.id === "object"
      )![0]
      expect(guard.where.OR).toContainEqual({ chunkStatus: "RUNNING" })
      expect(guard.where.OR).toContainEqual(
        expect.objectContaining({ jobs: expect.any(Object) })
      )
    }
  )
  it.each(["document", "folder", "base"])(
    "preserves the %s ownership boundary",
    async (kind) => {
      const pending =
        kind === "document"
          ? deleteKnowledgeDocument("other", "doc")
          : kind === "folder"
            ? deleteKnowledgeFolder("other", "folder", true)
            : deleteKnowledgeBase("other", "base")
      await expect(pending).rejects.toMatchObject({ status: 404 })
      expect(mocks.createJobs).not.toHaveBeenCalled()
      expect(mocks.removeOss).not.toHaveBeenCalled()
    }
  )
  it("requires recursive confirmation before deleting a non-empty folder", async () => {
    await expect(
      deleteKnowledgeFolder("owner", "folder", false)
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_FOLDER_NOT_EMPTY",
      details: { folderCount: 1, documentCount: 1 },
    })
    expect(mocks.createJobs).not.toHaveBeenCalled()
  })
  it.each(["folder", "base"])(
    "cleans all resources after deleting a %s",
    async (kind) => {
      const result =
        kind === "folder"
          ? await deleteKnowledgeFolder("owner", "folder", true)
          : await deleteKnowledgeBase("owner", "base")
      expect(result.documentIds).toEqual(["doc"])
      expect(result.cleanup).toEqual({ completed: 3, failed: 0, pending: 0 })
      expect(jobs).toHaveLength(0)
      if (kind === "folder")
        expect(result).toMatchObject({ folderIds: ["folder", "child"] })
      else expect(mocks.deleteBase).toHaveBeenCalled()
    }
  )
  it("keeps a safe ES cleanup window after uncertain index failure", async () => {
    document.chunkStatus = "FAILED"
    const result = await deleteKnowledgeDocument("owner", "doc")
    expect(result.cleanup).toEqual({ completed: 2, failed: 0, pending: 1 })
    expect(mocks.removeEs).not.toHaveBeenCalled()
    expect(jobs[0].availableAt.getTime()).toBeGreaterThanOrEqual(
      document.updatedAt.getTime() + DOCUMENT_PROCESSING_TIMEOUT_MS
    )
    jobs[0].availableAt = new Date(0)
    expect(await cleanupKnowledgeResources()).toEqual({
      completed: 1,
      failed: 0,
      pending: 0,
    })
  })
})

describe("one-shot cleanup recovery", () => {
  it("uses payload IDs to isolate resources even when foreign keys are gone", async () => {
    addJob()
    addJob({ payload: { documentId: "other", storageKey: "other-source" } })
    expect(await cleanupKnowledgeResources(["doc"])).toEqual({
      completed: 1,
      failed: 0,
      pending: 0,
    })
    expect(mocks.removeOss).toHaveBeenCalledWith("source")
    expect(mocks.removeOss).not.toHaveBeenCalledWith("other-source")
    expect(jobs).toHaveLength(1)
  })
  it("does not interrupt an unexpired cleanup owner or a historical wait window", async () => {
    addJob({
      status: "RUNNING",
      lockToken: "other",
      lockedUntil: new Date(Date.now() + 60_000),
    })
    addJob({ availableAt: new Date(Date.now() + 60_000) })
    expect(await cleanupKnowledgeResources()).toEqual({
      completed: 0,
      failed: 0,
      pending: 2,
    })
    expect(mocks.updateJobs).not.toHaveBeenCalled()
    expect(mocks.removeOss).not.toHaveBeenCalled()
  })
  it("recovers a crashed cleanup after its lease expires", async () => {
    addJob({
      status: "RUNNING",
      lockToken: "expired",
      lockedUntil: new Date(0),
    })
    expect(await cleanupKnowledgeResources()).toEqual({
      completed: 1,
      failed: 0,
      pending: 0,
    })
    expect(jobs).toHaveLength(0)
  })
  it("does not delete anything when another caller wins the claim", async () => {
    addJob()
    mocks.updateJobs.mockResolvedValueOnce({ count: 0 })
    expect(await cleanupKnowledgeResources()).toEqual({
      completed: 0,
      failed: 0,
      pending: 1,
    })
    expect(mocks.removeOss).not.toHaveBeenCalled()
    expect(jobs).toHaveLength(1)
  })
  it.each([null, [], {}, { target: "elasticsearch" }])(
    "records invalid persistent payloads as failures",
    async (payload) => {
      addJob({ payload })
      expect((await cleanupKnowledgeResources()).failed).toBe(1)
      expect(jobs[0].status).toBe("FAILED")
      expect(mocks.removeOss).not.toHaveBeenCalled()
      expect(mocks.removeEs).not.toHaveBeenCalled()
    }
  )
  it("reports the command failure without starting an idle loop and disconnects", async () => {
    const previous = process.exitCode
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    addJob()
    mocks.removeOss.mockRejectedValueOnce(new Error("Provider unavailable"))
    try {
      await import("@/workers/cleanup-documents")
      expect(process.exitCode).toBe(1)
      expect(mocks.disconnect).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledOnce()
      expect(jobs[0].status).toBe("FAILED")
    } finally {
      process.exitCode = previous
    }
  })
})
