/** 知识库简化后的行为回归：API 错误契约、上传补偿及任务成功/失败状态。 */
import { createHash } from "node:crypto"
import { HTTPException } from "hono/http-exception"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createKnowledgeDocumentUpload } from "@/lib/knowledge/document-service"
import {
  knowledgeBaseNotFound,
  knowledgeFolderNotEmpty,
  runKnowledgeApi,
} from "@/lib/knowledge/errors"
import { processNextDocumentJob } from "@/lib/knowledge/jobs/processor"
import { KnowledgeParseError } from "@/lib/knowledge/parsers/types"
import { deleteKnowledgeFolder } from "@/lib/knowledge/service"

const { db, oss } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    knowledgeBase: { findFirst: vi.fn() },
    knowledgeFolder: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    knowledgeDocument: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    documentProcessingJob: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  oss: {
    putOssObject: vi.fn(),
    getOssObject: vi.fn(),
    deleteOssObject: vi.fn(),
  },
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/storage/oss", () => oss)

const source = Buffer.from("# 文档\n\n正文")
const document = {
  id: "document-id",
  knowledgeBaseId: "base",
  knowledgeBase: { userId: "owner" },
  type: "MARKDOWN",
  originalFileName: "REPORT.MD",
  mimeType: "text/markdown",
  storageKey: "knowledge-documents/original.md",
  sizeBytes: source.byteLength,
  checksumSha256: createHash("sha256").update(source).digest("hex"),
  parseMetadata: null,
}
const job = {
  id: "job-id",
  documentId: document.id,
  type: "PARSE",
  status: "PENDING",
  payload: {},
  attempts: 0,
  maxAttempts: 3,
  lockedUntil: null,
}
const upload = {
  userId: "owner",
  knowledgeBaseId: "base",
  folderId: "folder",
  filename: document.originalFileName,
  mimeType: document.mimeType,
  buffer: source,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  db.$transaction.mockImplementation((callback) => callback(db))
  db.knowledgeBase.findFirst.mockResolvedValue({ id: upload.knowledgeBaseId })
  db.knowledgeFolder.findFirst.mockResolvedValue({
    id: upload.folderId,
    knowledgeBaseId: upload.knowledgeBaseId,
  })
  db.knowledgeFolder.findMany.mockResolvedValue([])
  db.knowledgeFolder.updateMany.mockResolvedValue({ count: 1 })
  db.knowledgeDocument.create.mockResolvedValue(document)
  db.knowledgeDocument.findFirst.mockResolvedValue(document)
  db.knowledgeDocument.findMany.mockResolvedValue([])
  db.knowledgeDocument.updateMany.mockResolvedValue({ count: 1 })
  db.documentProcessingJob.findFirst.mockResolvedValue(job)
  db.documentProcessingJob.updateMany.mockResolvedValue({ count: 1 })
  oss.putOssObject.mockResolvedValue(undefined)
  oss.getOssObject.mockResolvedValue(source)
  oss.deleteOssObject.mockResolvedValue(undefined)
})

afterEach(() => vi.restoreAllMocks())

describe("knowledge API error contract", () => {
  it.each([
    {
      error: knowledgeBaseNotFound(),
      status: 404,
      body: {
        error: { code: "KNOWLEDGE_BASE_NOT_FOUND", message: "知识库不存在" },
      },
    },
    {
      error: knowledgeFolderNotEmpty(2, 3),
      status: 409,
      body: {
        error: {
          code: "KNOWLEDGE_FOLDER_NOT_EMPTY",
          message: "文件夹不是空目录，请确认递归删除",
          details: { folderCount: 2, documentCount: 3 },
        },
      },
    },
    {
      error: new KnowledgeParseError("FILE_TOO_LARGE", "过大", 413),
      status: 413,
      body: { error: { code: "FILE_TOO_LARGE", message: "过大" } },
    },
  ])(
    "preserves status $status and JSON body",
    async ({ error, status, body }) => {
      const converted = await runKnowledgeApi(async () => {
        throw error
      }).catch((failure: unknown) => failure)
      expect(converted).toBeInstanceOf(HTTPException)
      if (!(converted instanceof HTTPException)) throw converted
      const response = converted.getResponse()
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual(body)
    }
  )

  it.each([new HTTPException(401), new Error("database failure")])(
    "rethrows other errors unchanged",
    async (error) => {
      await expect(
        runKnowledgeApi(async () => {
          throw error
        })
      ).rejects.toBe(error)
    }
  )
})

describe("knowledge upload", () => {
  it("keeps canonical storage keys and creates both document and parse job", async () => {
    await expect(createKnowledgeDocumentUpload(upload)).resolves.toBe(document)
    expect(oss.putOssObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^knowledge-documents\/owner\/base\/[0-9a-f-]{36}\.md$/
      ),
      source,
      document.mimeType
    )
    expect(db.knowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "REPORT",
          originalFileName: "REPORT.MD",
          type: "MARKDOWN",
          status: "QUEUED",
        }),
      })
    )
    expect(db.documentProcessingJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "PARSE", status: "PENDING" }),
      })
    )
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })

  it("rejects inaccessible knowledge bases before writing to OSS", async () => {
    db.knowledgeBase.findFirst.mockResolvedValue(null)
    await expect(createKnowledgeDocumentUpload(upload)).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_NOT_FOUND",
    })
    expect(oss.putOssObject).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.create).not.toHaveBeenCalled()
  })

  it("rechecks ownership after OSS upload and rolls back if the base was deleted", async () => {
    db.knowledgeBase.findFirst
      .mockResolvedValueOnce({ id: upload.knowledgeBaseId })
      .mockResolvedValueOnce(null)
    await expect(createKnowledgeDocumentUpload(upload)).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_NOT_FOUND",
    })
    expect(oss.deleteOssObject).toHaveBeenCalledWith(
      oss.putOssObject.mock.calls[0][0]
    )
    expect(db.knowledgeDocument.create).not.toHaveBeenCalled()
  })

  it("reclaims the original file and rethrows a database write failure", async () => {
    const error = new Error("database unavailable")
    db.knowledgeDocument.create.mockRejectedValue(error)
    await expect(createKnowledgeDocumentUpload(upload)).rejects.toBe(error)
    expect(oss.deleteOssObject).toHaveBeenCalledWith(
      oss.putOssObject.mock.calls[0][0]
    )
    expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
  })
})

describe("knowledge document jobs", () => {
  it("reparse replaces the body, advances its revision, and durably queues old image cleanup", async () => {
    const assetName = "20000000-0000-4000-8000-000000000002-0001.png"
    db.documentProcessingJob.findFirst.mockResolvedValue({
      ...job,
      type: "REPARSE",
    })
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      knowledgeBaseId: "base",
      parseMetadata: { assetNames: [assetName] },
    })
    await processNextDocumentJob()
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.knowledgeDocument.updateMany.mock.invocationCallOrder[1]
    )
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: { id: document.id, deletedAt: null },
      data: expect.objectContaining({
        status: "READY",
        markdownContent: source.toString(),
        contentRevision: { increment: 1 },
        revision: { increment: 1 },
        chunkStatus: "PENDING",
        chunkedContentRevision: null,
      }),
    })
    expect(db.documentProcessingJob.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          type: "CLEANUP",
          payload: {
            storageKey: `knowledge-document-assets/${document.id}/${assetName}`,
            documentId: document.id,
            reason: "reparse",
          },
        }),
      ],
    })
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })

  it("does not register old-image cleanup when the parse result loses its lease", async () => {
    const assetName = "20000000-0000-4000-8000-000000000002-0001.png"
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      parseMetadata: { assetNames: [assetName] },
    })
    db.documentProcessingJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 })
    await processNextDocumentJob()
    expect(db.documentProcessingJob.createMany).not.toHaveBeenCalled()
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "cleanup does not alter document parse status (OSS failure: %s)",
    async (failure) => {
      db.documentProcessingJob.findFirst.mockResolvedValue({
        ...job,
        type: "CLEANUP",
        payload: { storageKey: document.storageKey },
      })
      if (failure)
        oss.deleteOssObject.mockRejectedValue(new Error("OSS unavailable"))
      await processNextDocumentJob()
      expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
      expect(db.documentProcessingJob.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: failure ? "PENDING" : "SUCCEEDED",
          }),
        })
      )
    }
  )

  it("commits parsed content and job success", async () => {
    await expect(processNextDocumentJob()).resolves.toBe(true)
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: { id: document.id, deletedAt: null },
      data: expect.objectContaining({
        status: "READY",
        markdownContent: source.toString(),
        plainText: "文档\n\n正文",
      }),
    })
    expect(db.documentProcessingJob.updateMany).toHaveBeenLastCalledWith({
      where: { id: job.id, status: "RUNNING", lockToken: expect.any(String) },
      data: {
        status: "SUCCEEDED",
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: null,
      },
    })
  })

  it.each([
    { attempts: 0, jobStatus: "PENDING", documentStatus: "QUEUED" },
    { attempts: 2, jobStatus: "FAILED", documentStatus: "FAILED" },
  ])(
    "preserves retry behavior at attempt $attempts",
    async ({ attempts, jobStatus, documentStatus }) => {
      db.documentProcessingJob.findFirst.mockResolvedValue({ ...job, attempts })
      oss.getOssObject.mockRejectedValue(new Error("OSS unavailable"))
      await processNextDocumentJob()
      const update = db.documentProcessingJob.updateMany.mock.calls.at(-1)![0]
      expect(update.where).toEqual({
        id: job.id,
        status: "RUNNING",
        lockToken: expect.any(String),
      })
      expect(update.data).toMatchObject({
        status: jobStatus,
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: "PARSE_FAILED: 文档解析失败，请稍后重试",
      })
      expect(Object.hasOwn(update.data, "availableAt")).toBe(
        jobStatus === "PENDING"
      )
      expect(db.knowledgeDocument.updateMany).toHaveBeenLastCalledWith({
        where: { id: document.id, deletedAt: null },
        data: {
          status: documentStatus,
          parseErrorCode: documentStatus === "FAILED" ? "PARSE_FAILED" : null,
          parseErrorMessage:
            documentStatus === "FAILED" ? "文档解析失败，请稍后重试" : null,
        },
      })
    }
  )

  it("does not retry a file integrity failure", async () => {
    oss.getOssObject.mockResolvedValue(Buffer.from("changed file"))
    await processNextDocumentJob()
    expect(db.documentProcessingJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError:
            "FILE_SIGNATURE_MISMATCH: 原文件完整性校验失败，请重新上传",
        }),
      })
    )
  })

  it("does not update document failure state after losing the lease", async () => {
    oss.getOssObject.mockRejectedValue(new Error("OSS unavailable"))
    db.documentProcessingJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    await processNextDocumentJob()
    // 只有领取阶段的 PARSING 更新；失败处理不覆盖新 Worker 的结果。
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledTimes(1)
  })

  it("deletes the cleanup object before marking the task successful", async () => {
    db.documentProcessingJob.findFirst.mockResolvedValue({
      ...job,
      type: "CLEANUP",
      documentId: null,
      payload: { storageKey: document.storageKey },
    })
    await processNextDocumentJob()
    expect(oss.deleteOssObject).toHaveBeenCalledWith(document.storageKey)
    expect(db.documentProcessingJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      })
    )
  })

  it("does not delete an object for a malformed cleanup payload", async () => {
    db.documentProcessingJob.findFirst.mockResolvedValue({
      ...job,
      type: "CLEANUP",
      documentId: null,
      payload: [{ storageKey: document.storageKey }],
    })
    await processNextDocumentJob()
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
    expect(db.documentProcessingJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING" }),
      })
    )
  })
})

describe("knowledge folder deletion", () => {
  it("allows deleting an empty folder with zero child folders", async () => {
    db.knowledgeDocument.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      deleteKnowledgeFolder(upload.userId, upload.folderId, false)
    ).resolves.toMatchObject({
      id: upload.folderId,
      folderCount: 1,
      documentCount: 0,
    })
    expect(db.documentProcessingJob.updateMany).not.toHaveBeenCalled()
    expect(db.documentProcessingJob.createMany).not.toHaveBeenCalled()
  })

  it("keeps the nonempty-folder error and child count without recursive confirmation", async () => {
    db.knowledgeFolder.findMany
      .mockResolvedValueOnce([{ id: "child" }])
      .mockResolvedValueOnce([])
    await expect(
      deleteKnowledgeFolder(upload.userId, upload.folderId, false)
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_FOLDER_NOT_EMPTY",
      status: 409,
      details: { folderCount: 1, documentCount: 0 },
    })
    expect(db.knowledgeFolder.updateMany).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it("cancels parsing and registers original-file cleanup during recursive deletion", async () => {
    db.knowledgeDocument.findMany.mockResolvedValue([
      { ...document, knowledgeBaseId: upload.knowledgeBaseId },
    ])
    await deleteKnowledgeFolder(upload.userId, upload.folderId, true)
    expect(db.documentProcessingJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          documentId: { in: [document.id] },
          type: { in: ["PARSE", "REPARSE", "RECHUNK"] },
          status: { in: ["PENDING", "RUNNING"] },
        },
        data: {
          status: "CANCELLED",
          lockedAt: null,
          lockedUntil: null,
          lockToken: null,
        },
      })
    )
    expect(db.documentProcessingJob.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          type: "CLEANUP",
          status: "PENDING",
          payload: {
            storageKey: document.storageKey,
            documentId: document.id,
            reason: "folder-delete",
          },
        }),
      ],
    })
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [document.id] }, deletedAt: null },
      data: { deletedAt: expect.any(Date), revision: { increment: 1 } },
    })
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })
})
