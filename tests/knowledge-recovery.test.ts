import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  KnowledgeDocument,
  DocumentProcessingJob,
} from "@/app/generated/prisma"
import { recoverInterruptedDocuments } from "@/lib/knowledge/documents/recover-documents"
import { DOCUMENT_PROCESSING_TIMEOUT_MS } from "@/lib/knowledge/documents/timeouts"

const mocks = vi.hoisted(() => ({
  findDocuments: vi.fn(),
  findDocument: vi.fn(),
  updateDocument: vi.fn(),
  findJobs: vi.fn(),
  deleteJobs: vi.fn(),
  transaction: vi.fn(),
  raw: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({
  default: {
    knowledgeDocument: {
      findMany: mocks.findDocuments,
      findFirst: mocks.findDocument,
      updateMany: mocks.updateDocument,
    },
    documentProcessingJob: {
      findMany: mocks.findJobs,
      deleteMany: mocks.deleteJobs,
    },
    $transaction: mocks.transaction,
    $disconnect: mocks.disconnect,
  },
}))
type Document = Pick<
  KnowledgeDocument,
  | "id"
  | "knowledgeBaseId"
  | "status"
  | "chunkStatus"
  | "contentRevision"
  | "updatedAt"
  | "markdownContent"
  | "parseMetadata"
  | "storageKey"
  | "chunkedContentRevision"
  | "parseErrorCode"
  | "parseErrorMessage"
  | "chunkErrorMessage"
>
type Job = Pick<
  DocumentProcessingJob,
  "id" | "documentId" | "status" | "type" | "lockToken" | "lockedUntil"
>
let document: Document
let jobs: Job[]
const db = {
  $queryRaw: mocks.raw,
  knowledgeDocument: {
    findFirst: mocks.findDocument,
    updateMany: mocks.updateDocument,
  },
  documentProcessingJob: {
    findMany: mocks.findJobs,
    deleteMany: mocks.deleteJobs,
  },
}
const initialArgv = [...process.argv]
const initialExitCode = process.exitCode
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.argv = [...initialArgv]
  process.exitCode = initialExitCode
  document = {
    id: "document",
    knowledgeBaseId: "base",
    status: "PARSING",
    chunkStatus: "READY",
    contentRevision: 4,
    updatedAt: new Date(Date.now() - DOCUMENT_PROCESSING_TIMEOUT_MS - 1000),
    markdownContent: "Saved body",
    storageKey: "original",
    parseMetadata: { assetNames: ["saved-image"] },
    chunkedContentRevision: 4,
    parseErrorCode: null,
    parseErrorMessage: null,
    chunkErrorMessage: null,
  }
  jobs = []
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
  mocks.findDocuments
    .mockReset()
    .mockResolvedValue([{ id: "document", knowledgeBaseId: "base" }])
  mocks.findDocument
    .mockReset()
    .mockImplementation(async () => structuredClone(document))
  mocks.updateDocument
    .mockReset()
    .mockImplementation(async ({ where, data }) => {
      if (
        where.contentRevision !== document.contentRevision ||
        where.updatedAt.getTime() !== document.updatedAt.getTime() ||
        where.status !== document.status ||
        where.chunkStatus !== document.chunkStatus
      )
        return { count: 0 }
      Object.assign(document, data)
      return { count: 1 }
    })
  mocks.findJobs
    .mockReset()
    .mockImplementation(async ({ where }) =>
      jobs
        .filter(
          (job) => job.type !== "CLEANUP" && job.documentId === where.documentId
        )
        .map((job) => structuredClone(job))
    )
  mocks.deleteJobs.mockReset().mockImplementation(async ({ where }) => {
    const previous = jobs.length
    jobs = jobs.filter(
      (job) =>
        !(
          job.type !== "CLEANUP" &&
          (where.id
            ? job.id === where.id &&
              job.status === where.status &&
              job.lockToken === where.lockToken &&
              job.lockedUntil?.getTime() === where.lockedUntil?.getTime()
            : job.documentId === where.documentId)
        )
    )
    return { count: previous - jobs.length }
  })
  mocks.raw.mockReset().mockResolvedValue([])
  mocks.transaction.mockReset().mockImplementation(async (execute) => {
    const snapshot = structuredClone({ document, jobs })
    try {
      return await execute(db)
    } catch (error) {
      document = snapshot.document
      jobs = snapshot.jobs
      throw error
    }
  })
  mocks.disconnect.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  process.argv = [...initialArgv]
  process.exitCode = initialExitCode
  vi.restoreAllMocks()
})
function addJob(input: Partial<Job> = {}) {
  const job: Job = {
    id: `job-${jobs.length}`,
    type: "PARSE",
    status: "PENDING",
    documentId: document.id,
    lockToken: null,
    lockedUntil: null,
    ...input,
  }
  jobs.push(job)
  return job
}

describe("offline document recovery", () => {
  it.each(["QUEUED", "PARSING"] as const)(
    "marks interrupted %s as failed while preserving the original, saved body and revision",
    async (status) => {
      document.status = status
      addJob()
      const before = structuredClone(document)
      expect(await recoverInterruptedDocuments()).toEqual({
        recovered: 1,
        retired: 1,
        pending: 0,
      })
      expect(document).toMatchObject({
        status: "FAILED",
        parseErrorCode: "PARSE_FAILED",
        storageKey: before.storageKey,
        markdownContent: before.markdownContent,
        parseMetadata: before.parseMetadata,
        contentRevision: 4,
        chunkedContentRevision: 4,
      })
      expect(jobs).toHaveLength(0)
      expect(mocks.raw).toHaveBeenCalled()
    }
  )
  it.each(["PENDING", "RUNNING"] as const)(
    "marks interrupted index %s as failed without making saved content unreadable",
    async (chunkStatus) => {
      document.status = "READY"
      document.chunkStatus = chunkStatus
      expect(await recoverInterruptedDocuments()).toEqual({
        recovered: 1,
        retired: 0,
        pending: 0,
      })
      expect(document).toMatchObject({
        status: "READY",
        chunkStatus: "FAILED",
        contentRevision: 4,
        markdownContent: "Saved body",
        chunkedContentRevision: 4,
      })
    }
  )
  it.each(["PARSE", "REPARSE", "RECHUNK"] as const)(
    "retires obsolete %s records without changing a healthy document or CLEANUP record",
    async (type) => {
      document.status = "READY"
      addJob({ type, status: "SUCCEEDED" })
      const cleanup = addJob({ type: "CLEANUP", status: "FAILED" })
      const before = structuredClone(document)
      expect(await recoverInterruptedDocuments()).toEqual({
        recovered: 0,
        retired: 1,
        pending: 0,
      })
      expect(document).toEqual(before)
      expect(jobs).toEqual([cleanup])
    }
  )
  it("leaves recent direct processing and its old records untouched", async () => {
    document.updatedAt = new Date()
    addJob()
    expect(await recoverInterruptedDocuments()).toEqual({
      recovered: 0,
      retired: 0,
      pending: 1,
    })
    expect(document.status).toBe("PARSING")
    expect(jobs).toHaveLength(1)
    expect(mocks.updateDocument).not.toHaveBeenCalled()
  })
  it("respects a live legacy lease even if the document timestamp is old", async () => {
    addJob({
      status: "RUNNING",
      lockToken: "live",
      lockedUntil: new Date(Date.now() + 60_000),
    })
    expect((await recoverInterruptedDocuments()).pending).toBe(1)
    expect(mocks.updateDocument).not.toHaveBeenCalled()
    expect(jobs).toHaveLength(1)
  })
  it("retires an expired lease after the document safety window ends", async () => {
    addJob({
      status: "RUNNING",
      lockToken: "expired",
      lockedUntil: new Date(0),
    })
    expect(await recoverInterruptedDocuments()).toEqual({
      recovered: 1,
      retired: 1,
      pending: 0,
    })
    expect(document.status).toBe("FAILED")
  })
  it("does not retire old records if the guarded document update loses a race", async () => {
    addJob()
    mocks.updateDocument.mockResolvedValueOnce({ count: 0 })
    expect((await recoverInterruptedDocuments()).pending).toBe(1)
    expect(jobs).toHaveLength(1)
    expect(document.status).toBe("PARSING")
  })
  it("rolls back the state recovery if retiring its records fails", async () => {
    addJob()
    const before = structuredClone(document)
    mocks.deleteJobs.mockRejectedValueOnce(new Error("Database unavailable"))
    await expect(recoverInterruptedDocuments()).rejects.toThrow(
      "Database unavailable"
    )
    expect(document).toEqual(before)
    expect(jobs).toHaveLength(1)
  })
  it("skips documents deleted after candidate selection", async () => {
    mocks.findDocument.mockResolvedValueOnce(null)
    expect(await recoverInterruptedDocuments()).toEqual({
      recovered: 0,
      retired: 0,
      pending: 0,
    })
    expect(mocks.updateDocument).not.toHaveBeenCalled()
  })
  it("retires orphaned legacy records while retaining orphaned cleanup and live leases", async () => {
    mocks.findDocuments.mockResolvedValue([])
    addJob({ documentId: null, status: "FAILED" })
    const cleanup = addJob({
      documentId: null,
      type: "CLEANUP",
      status: "PENDING",
    })
    const live = addJob({
      documentId: null,
      status: "RUNNING",
      lockToken: "live",
      lockedUntil: new Date(Date.now() + 60_000),
    })
    expect(await recoverInterruptedDocuments()).toEqual({
      recovered: 0,
      retired: 1,
      pending: 1,
    })
    expect(jobs).toEqual([cleanup, live])
  })
  it("does not count an orphaned record as retired when another caller changed it", async () => {
    mocks.findDocuments.mockResolvedValue([])
    addJob({ documentId: null })
    mocks.deleteJobs.mockResolvedValueOnce({ count: 0 })
    expect(await recoverInterruptedDocuments()).toEqual({
      recovered: 0,
      retired: 0,
      pending: 1,
    })
  })
})

describe("one-shot recovery command", () => {
  it("requires the explicit offline flag before accessing the database", async () => {
    process.argv = ["node", "recover-documents.ts"]
    await expect(import("@/workers/recover-documents")).rejects.toThrow(
      "--offline"
    )
    expect(mocks.findDocuments).not.toHaveBeenCalled()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
  it("runs once, reports restored counts and disconnects", async () => {
    process.argv = ["node", "recover-documents.ts", "--offline"]
    addJob()
    await import("@/workers/recover-documents")
    expect(document.status).toBe("FAILED")
    expect(jobs).toHaveLength(0)
    expect(mocks.findDocuments).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(initialExitCode)
  })
  it("returns a nonzero exit code if a safety window is still open", async () => {
    process.argv = ["node", "recover-documents.ts", "--offline"]
    document.updatedAt = new Date()
    await import("@/workers/recover-documents")
    expect(process.exitCode).toBe(1)
    expect(document.status).toBe("PARSING")
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
  it("propagates database failure and always disconnects", async () => {
    process.argv = ["node", "recover-documents.ts", "--offline"]
    mocks.findDocuments.mockRejectedValueOnce(new Error("Database unavailable"))
    await expect(import("@/workers/recover-documents")).rejects.toThrow(
      "Database unavailable"
    )
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
})
