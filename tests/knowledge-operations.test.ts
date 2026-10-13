/** P2-c 回归：真实路由和业务函数，数据库与 OSS 使用模拟，不操作用户文件。 */
import { Hono, type Context, type Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { knowledgeDocumentRoute } from "@/app/api/[[...route]]/knowledge-document"
import { knowledgeFolderRoute } from "@/app/api/[[...route]]/knowledge-folder"
import { knowledgeBaseRoute } from "@/app/api/[[...route]]/knowledge-base"
import { purgeDeletedKnowledgeBase } from "@/lib/knowledge/management/service"

const { db, oss, login } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    knowledgeBase: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    knowledgeFolder: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    knowledgeDocument: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    documentProcessingJob: {
      create: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  oss: {
    getOssObject: vi.fn(),
    deleteOssObject: vi.fn(),
    putOssObject: vi.fn(),
    getOssPreviewUrl: vi.fn(),
  },
  login: { authenticated: true },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/storage/oss", () => oss)
vi.mock("@/lib/hono/hono-middware", () => ({
  getAuthUser: async (c: Context, next: Next) => {
    if (!login.authenticated)
      throw new HTTPException(401, { message: "未认证" })
    c.set("user", { id: "owner" })
    await next()
  },
}))

const id = "10000000-0000-4000-8000-000000000001"
const assetName = "20000000-0000-4000-8000-000000000002-0001.png"
const document = {
  id,
  knowledgeBaseId: "base-id",
  status: "READY",
  storageKey: "knowledge-documents/owner/base-id/original.md",
  originalFileName: "报告.md",
  mimeType: "text/markdown",
  checksumSha256: "checksum",
  markdownContent: "已编辑的正文",
  contentRevision: 4,
  parseMetadata: { assetNames: [assetName] },
}
const app = new Hono()
  .route("/documents", knowledgeDocumentRoute)
  .route("/folders", knowledgeFolderRoute)
  .route("/bases", knowledgeBaseRoute)
  .onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "internal error" }, 500)
  )

function request(
  operation: "original" | "preview" | "reparse" | "delete" | "rename",
  json: unknown = { expectedContentRevision: 4 },
  documentId = id
) {
  return app.request(
    `/documents/${documentId}${operation === "delete" || operation === "rename" ? "" : `/${operation}`}`,
    {
      method:
        operation === "original" || operation === "preview"
          ? "GET"
          : operation === "reparse"
            ? "POST"
            : operation === "rename"
              ? "PATCH"
              : "DELETE",
      ...(operation === "reparse" || operation === "rename"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(json),
          }
        : {}),
    }
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  login.authenticated = true
  db.$transaction.mockImplementation((callback) => callback(db))
  db.knowledgeBase.findFirst.mockResolvedValue({ id: document.knowledgeBaseId })
  db.knowledgeDocument.findFirst.mockResolvedValue(document)
  db.knowledgeDocument.updateMany.mockResolvedValue({ count: 1 })
  db.knowledgeDocument.deleteMany.mockResolvedValue({ count: 1 })
  db.knowledgeFolder.deleteMany.mockResolvedValue({ count: 2 })
  // 详情响应不能包含内部对象键，与实际 Prisma select 的结果一致。
  db.knowledgeDocument.findUniqueOrThrow.mockResolvedValue({
    id,
    status: "QUEUED",
    contentRevision: 4,
  })
  oss.getOssObject.mockResolvedValue(Buffer.from("# 原件正文"))
  oss.getOssPreviewUrl.mockResolvedValue(
    "https://oss.example.test/file?signature=temporary"
  )
})

describe("read-only knowledge content", () => {
  it("does not expose the former body save endpoint", async () => {
    const response = await app.request(`/documents/${id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdownContent: "replacement",
        expectedContentRevision: 4,
      }),
    })
    expect(response.status).toBe(404)
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })
})

describe("historical deleted knowledge base purge", () => {
  beforeEach(() => {
    db.knowledgeBase.findFirst.mockResolvedValue({
      id: "base-id",
      deletedAt: new Date(),
    })
    db.knowledgeDocument.findMany.mockResolvedValue([document])
  })

  it("rechecks the deletion marker under the base lock and reuses physical deletion", async () => {
    await expect(purgeDeletedKnowledgeBase("base-id")).resolves.toMatchObject({
      documentCount: 1,
      folderCount: 2,
    })
    expect(db.knowledgeBase.findFirst).toHaveBeenCalledWith({
      where: { id: "base-id", deletedAt: { not: null } },
      select: { id: true },
    })
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.knowledgeBase.findFirst.mock.invocationCallOrder[0]
    )
    expect(db.knowledgeBase.delete).toHaveBeenCalledWith({
      where: { id: "base-id" },
    })
    expect(db.documentProcessingJob.createMany).toHaveBeenCalled()
    expect(db.documentProcessingJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          knowledgeBaseId: "base-id",
          type: "CLEANUP",
          status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
        },
        data: expect.objectContaining({
          status: "PENDING",
          attempts: 0,
          availableAt: expect.any(Date),
        }),
      })
    )
  })

  it("skips a missing or no-longer-deleted base without deleting any records", async () => {
    db.knowledgeBase.findFirst.mockResolvedValue(null)
    await expect(purgeDeletedKnowledgeBase("base-id")).resolves.toBeNull()
    expect(db.documentProcessingJob.updateMany).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.deleteMany).not.toHaveBeenCalled()
    expect(db.knowledgeFolder.deleteMany).not.toHaveBeenCalled()
    expect(db.knowledgeBase.delete).not.toHaveBeenCalled()
  })

  it("does not physically delete the base if cleanup registration fails", async () => {
    db.documentProcessingJob.createMany.mockRejectedValue(
      new Error("database unavailable")
    )
    await expect(purgeDeletedKnowledgeBase("base-id")).rejects.toThrow(
      "database unavailable"
    )
    expect(db.knowledgeDocument.deleteMany).not.toHaveBeenCalled()
    expect(db.knowledgeFolder.deleteMany).not.toHaveBeenCalled()
    expect(db.knowledgeBase.delete).not.toHaveBeenCalled()
  })
})

describe("knowledge original preview", () => {
  it.each(["QUEUED", "PARSING", "READY", "FAILED"])(
    "signs an original independently of %s and parsed content",
    async (status) => {
      db.knowledgeDocument.findFirst.mockResolvedValue({ ...document, status })
      const before = Date.now()
      const response = await request("preview")
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(body.file).toEqual({
        fileName: document.originalFileName,
        mimeType: document.mimeType,
        url: "https://oss.example.test/file?signature=temporary",
        expiresAt: expect.any(Number),
      })
      expect(body.file.expiresAt).toBeGreaterThanOrEqual(before + 900_000)
      expect(oss.getOssPreviewUrl).toHaveBeenCalledWith(
        document.storageKey,
        900
      )
      expect(db.knowledgeDocument.findFirst).toHaveBeenCalledWith({
        where: {
          id,
          deletedAt: null,
          knowledgeBase: { userId: "owner", deletedAt: null },
        },
        select: { originalFileName: true, mimeType: true, storageKey: true },
      })
      expect(oss.getOssObject).not.toHaveBeenCalled()
      expect(db.$transaction).not.toHaveBeenCalled()
      expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
      expect(JSON.stringify(body)).not.toContain(document.storageKey)
      expect(JSON.stringify(body)).not.toContain(document.markdownContent)
    }
  )

  it("fails visibly if signing fails, without returning a parsed-body fallback", async () => {
    oss.getOssPreviewUrl.mockRejectedValue(new Error("signing failed"))
    expect((await request("preview")).status).toBe(500)
    expect(oss.getOssObject).not.toHaveBeenCalled()
  })

  it("does not sign a document without an original", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      storageKey: null,
    })
    expect((await request("preview")).status).toBe(409)
    expect(oss.getOssPreviewUrl).not.toHaveBeenCalled()
  })
})

describe("knowledge original download", () => {
  it("returns the original bytes as a private attachment without exposing storage keys", async () => {
    const response = await request("original")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("# 原件正文")
    expect(oss.getOssObject).toHaveBeenCalledWith(document.storageKey)
    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("报告.md")}`
    )
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream"
    )
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-disposition")).not.toContain(
      document.storageKey
    )
  })

  it("does not allow filenames to inject paths or response headers", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      originalFileName: '../报告"\r\nX-Test: injected.md',
    })
    const response = await request("original")
    expect(response.status).toBe(200)
    expect(response.headers.get("x-test")).toBeNull()
    const header = response.headers.get("content-disposition") ?? ""
    expect(header).not.toContain("../")
    expect(header).not.toMatch(/[\r\n]/)
    expect(header).toContain("%22")
  })

  it("supports an emoji filename cut at the upload filename length limit", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      originalFileName: "😀".repeat(140) + ".md",
    })
    expect((await request("original")).status).toBe(200)
  })

  it("reports a missing original rather than downloading an empty file", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      storageKey: null,
    })
    const response = await request("original")
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe(
      "KNOWLEDGE_DOCUMENT_NO_ORIGINAL"
    )
    expect(oss.getOssObject).not.toHaveBeenCalled()
  })

  it("exposes OSS failure as an error response", async () => {
    oss.getOssObject.mockRejectedValue(new Error("OSS unavailable"))
    expect((await request("original")).status).toBe(500)
  })
})

describe("knowledge reparse", () => {
  it.each(["READY", "FAILED"])(
    "queues a %s document without erasing its existing body",
    async (status) => {
      db.knowledgeDocument.findFirst.mockResolvedValue({ ...document, status })
      const response = await request("reparse")
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({
        success: true,
        document: { id, status: "QUEUED", contentRevision: 4 },
      })
      expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
        where: {
          id,
          deletedAt: null,
          knowledgeBase: { userId: "owner", deletedAt: null },
          status: { in: ["READY", "FAILED"] },
          contentRevision: 4,
        },
        data: {
          status: "QUEUED",
          parseErrorCode: null,
          parseErrorMessage: null,
        },
      })
      expect(db.documentProcessingJob.create).toHaveBeenCalledWith({
        data: {
          documentId: id,
          knowledgeBaseId: "base-id",
          type: "REPARSE",
          status: "PENDING",
          targetRevision: 4,
          dedupeKey: expect.stringMatching(/^reparse:/),
          payload: {},
        },
      })
      expect(db.$queryRaw).toHaveBeenCalledOnce()
      expect(oss.getOssObject).not.toHaveBeenCalled()
      expect(oss.deleteOssObject).not.toHaveBeenCalled()
    }
  )

  it.each(["QUEUED", "PARSING"])(
    "does not enqueue a second task for a %s document",
    async (status) => {
      db.knowledgeDocument.findFirst.mockResolvedValue({ ...document, status })
      const response = await request("reparse")
      expect(response.status).toBe(409)
      expect((await response.json()).error.code).toBe(
        "KNOWLEDGE_DOCUMENT_PROCESSING"
      )
      expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
    }
  )

  it("does not overwrite a newer revision after a stale confirmation", async () => {
    db.knowledgeDocument.updateMany.mockResolvedValue({ count: 0 })
    const response = await request("reparse")
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("CONTENT_REVISION_CONFLICT")
    expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
    expect(db.documentProcessingJob.updateMany).not.toHaveBeenCalled()
  })

  it("rejects reparse when the original is absent", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      storageKey: null,
    })
    expect((await request("reparse")).status).toBe(409)
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { expectedContentRevision: -1 },
    { expectedContentRevision: 4, storageKey: "other-file" },
  ])("validates the confirmation body at the HTTP boundary", async (json) => {
    expect((await request("reparse", json)).status).toBe(400)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("creates the job and status change in the same transaction and does not fake success on failure", async () => {
    db.documentProcessingJob.create.mockRejectedValue(
      new Error("database unavailable")
    )
    expect((await request("reparse")).status).toBe(500)
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" })
    )
    expect(db.knowledgeDocument.findUniqueOrThrow).not.toHaveBeenCalled()
  })
})

describe("knowledge document deletion", () => {
  it("physically deletes and registers original plus image cleanup without deleting OSS inline", async () => {
    const response = await request("delete")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      id,
      knowledgeBaseId: "base-id",
    })
    expect(db.documentProcessingJob.deleteMany).toHaveBeenCalledWith({
      where: {
        documentId: id,
        type: { not: "CLEANUP" },
      },
    })
    expect(db.documentProcessingJob.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        ...[
          document.storageKey,
          `knowledge-document-assets/${id}/${assetName}`,
        ].map((storageKey) =>
          expect.objectContaining({
            type: "CLEANUP",
            status: "PENDING",
            payload: { storageKey, documentId: id, reason: "document-delete" },
          })
        ),
        expect.objectContaining({
          dedupeKey: `cleanup:es:${id}`,
          payload: {
            target: "elasticsearch",
            documentId: id,
            reason: "document-delete",
          },
          availableAt: expect.any(Date),
        }),
      ],
    })
    expect(db.knowledgeDocument.delete).toHaveBeenCalledWith({
      where: { id },
    })
    expect(
      db.documentProcessingJob.createMany.mock.invocationCallOrder[0]
    ).toBeLessThan(
      db.documentProcessingJob.deleteMany.mock.invocationCallOrder[0]
    )
    expect(
      db.documentProcessingJob.deleteMany.mock.invocationCallOrder[0]
    ).toBeLessThan(db.knowledgeDocument.delete.mock.invocationCallOrder[0])
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })

  it("allows deleting a document without an original or images", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue({
      ...document,
      storageKey: null,
      parseMetadata: null,
    })
    expect((await request("delete")).status).toBe(200)
    expect(db.documentProcessingJob.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          dedupeKey: `cleanup:es:${id}`,
          payload: {
            target: "elasticsearch",
            documentId: id,
            reason: "document-delete",
          },
        }),
      ],
    })
  })

  it("fails rather than deleting without a durable cleanup record", async () => {
    db.documentProcessingJob.createMany.mockRejectedValue(
      new Error("database unavailable")
    )
    expect((await request("delete")).status).toBe(500)
    expect(db.knowledgeDocument.delete).not.toHaveBeenCalled()
    expect(db.documentProcessingJob.deleteMany).not.toHaveBeenCalled()
  })
})

describe("knowledge operation ownership", () => {
  it.each(["original", "preview", "reparse", "delete", "rename"] as const)(
    "requires authentication for %s",
    async (operation) => {
      login.authenticated = false
      expect((await request(operation, { title: "新名称" })).status).toBe(401)
      expect(db.knowledgeDocument.findFirst).not.toHaveBeenCalled()
      expect(oss.getOssObject).not.toHaveBeenCalled()
    }
  )

  it.each(["original", "preview", "reparse", "delete", "rename"] as const)(
    "rejects another user's or deleted document for %s",
    async (operation) => {
      db.knowledgeDocument.findFirst.mockResolvedValue(null)
      expect(
        (
          await request(
            operation,
            operation === "rename" ? { title: "新名称" } : undefined
          )
        ).status
      ).toBe(404)
      expect(db.knowledgeDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id,
            deletedAt: null,
            knowledgeBase: { userId: "owner", deletedAt: null },
          },
        })
      )
      expect(oss.getOssObject).not.toHaveBeenCalled()
      expect(oss.getOssPreviewUrl).not.toHaveBeenCalled()
      expect(db.knowledgeDocument.update).not.toHaveBeenCalled()
      expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
    }
  )

  it.each(["reparse", "delete"] as const)(
    "rechecks document deletion after acquiring the lock for %s",
    async (operation) => {
      db.knowledgeDocument.findFirst
        .mockResolvedValueOnce(document)
        .mockResolvedValueOnce(null)
      expect((await request(operation)).status).toBe(404)
      expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
      expect(db.documentProcessingJob.createMany).not.toHaveBeenCalled()
    }
  )

  it.each(["reparse", "delete"] as const)(
    "rejects a base deleted while waiting for the lock for %s",
    async (operation) => {
      db.knowledgeBase.findFirst.mockResolvedValue(null)
      expect((await request(operation)).status).toBe(404)
      expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
      expect(db.documentProcessingJob.createMany).not.toHaveBeenCalled()
    }
  )

  it.each(["original", "preview", "reparse", "delete", "rename"] as const)(
    "rejects invalid document IDs for %s",
    async (operation) => {
      expect((await request(operation, undefined, "invalid-id")).status).toBe(
        400
      )
      expect(db.knowledgeDocument.findFirst).not.toHaveBeenCalled()
    }
  )
})

describe("knowledge tree mutations", () => {
  const folderId = "30000000-0000-4000-8000-000000000003"
  const childId = "40000000-0000-4000-8000-000000000004"
  const baseId = "50000000-0000-4000-8000-000000000005"
  const folder = { id: folderId, knowledgeBaseId: baseId, name: "目录" }
  beforeEach(() => {
    db.knowledgeBase.findFirst.mockResolvedValue({ id: baseId })
    db.knowledgeFolder.findFirst.mockResolvedValue(folder)
    db.knowledgeFolder.findMany.mockResolvedValue([])
    db.knowledgeFolder.update.mockResolvedValue({ ...folder, name: "新目录" })
    db.knowledgeFolder.updateMany.mockResolvedValue({ count: 2 })
    db.knowledgeDocument.findMany.mockResolvedValue([document])
  })

  it.each(["QUEUED", "PARSING", "READY", "FAILED"])(
    "renames a %s file without changing content or the original",
    async (status) => {
      db.knowledgeDocument.findFirst.mockResolvedValue({ ...document, status })
      db.knowledgeDocument.findUniqueOrThrow.mockResolvedValue({
        id,
        title: "新名称",
        knowledgeBaseId: baseId,
      })
      const response = await request("rename", { title: "  新名称  " })
      expect(response.status).toBe(200)
      expect((await response.json()).document.title).toBe("新名称")
      expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
        where: {
          id,
          deletedAt: null,
          knowledgeBase: { userId: "owner", deletedAt: null },
        },
        data: { title: "新名称" },
      })
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.knowledgeDocument.updateMany.mock.invocationCallOrder[0]
      )
      expect(db.documentProcessingJob.create).not.toHaveBeenCalled()
      expect(oss.putOssObject).not.toHaveBeenCalled()
      expect(oss.deleteOssObject).not.toHaveBeenCalled()
    }
  )

  it.each([
    { title: " " },
    { title: "x".repeat(256) },
    { title: "有效", storageKey: "other" },
  ])("rejects invalid rename input", async (json) => {
    expect((await request("rename", json)).status).toBe(400)
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it("rejects renaming a file deleted while waiting for the base lock", async () => {
    db.knowledgeDocument.updateMany.mockResolvedValue({ count: 0 })
    expect((await request("rename", { title: "新名称" })).status).toBe(404)
    expect(db.knowledgeDocument.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it("renames a folder through the existing endpoint without traversing or moving its subtree", async () => {
    const response = await app.request(`/folders/${folderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: " 新目录 " }),
    })
    expect(response.status).toBe(200)
    expect(db.knowledgeFolder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: folderId },
        data: { name: "新目录" },
      })
    )
    expect(db.knowledgeFolder.findMany).not.toHaveBeenCalled()
  })

  it("deletes the complete folder subtree and registers durable cleanup for originals and images", async () => {
    db.knowledgeFolder.findMany
      .mockResolvedValueOnce([{ id: childId }])
      .mockResolvedValueOnce([])
    const response = await app.request(`/folders/${folderId}?recursive=true`, {
      method: "DELETE",
    })
    expect(response.status).toBe(200)
    const { deleted } = await response.json()
    expect(deleted.folderIds).toEqual([folderId, childId])
    expect(deleted.documentIds).toEqual([id])
    expect(db.knowledgeFolder.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [folderId, childId] } },
    })
    expect(db.documentProcessingJob.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          documentId: { in: [id] },
          type: { not: "CLEANUP" },
        }),
      })
    )
    expect(db.documentProcessingJob.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            payload: expect.objectContaining({
              storageKey: document.storageKey,
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              storageKey: `knowledge-document-assets/${id}/${assetName}`,
            }),
          }),
          expect.objectContaining({
            payload: {
              target: "elasticsearch",
              documentId: id,
              reason: "folder-delete",
            },
          }),
        ],
      })
    )
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })

  it("deletes the entire knowledge base for the root directory", async () => {
    const response = await app.request(`/bases/${baseId}`, { method: "DELETE" })
    expect(response.status).toBe(200)
    expect((await response.json()).deleted.documentIds).toEqual([id])
    expect(db.knowledgeBase.delete).toHaveBeenCalledWith({
      where: { id: baseId },
    })
    expect(db.knowledgeFolder.deleteMany).toHaveBeenCalledWith({
      where: { knowledgeBaseId: baseId },
    })
    expect(db.knowledgeDocument.deleteMany).toHaveBeenCalledWith({
      where: { knowledgeBaseId: baseId },
    })
    expect(db.documentProcessingJob.createMany).toHaveBeenCalled()
    expect(db.documentProcessingJob.deleteMany).toHaveBeenCalledWith({
      where: { knowledgeBaseId: baseId, type: { not: "CLEANUP" } },
    })
    expect(db.knowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { knowledgeBaseId: baseId } })
    )
    expect(
      db.knowledgeDocument.deleteMany.mock.invocationCallOrder[0]
    ).toBeLessThan(db.knowledgeFolder.deleteMany.mock.invocationCallOrder[0])
    expect(
      db.knowledgeFolder.deleteMany.mock.invocationCallOrder[0]
    ).toBeLessThan(db.knowledgeBase.delete.mock.invocationCallOrder[0])
    expect(oss.deleteOssObject).not.toHaveBeenCalled()
  })

  it.each([`/folders/${folderId}?recursive=true`, `/bases/${baseId}`])(
    "preserves business records if durable cleanup cannot be registered for %s",
    async (path) => {
      db.documentProcessingJob.createMany.mockRejectedValue(
        new Error("database unavailable")
      )
      expect((await app.request(path, { method: "DELETE" })).status).toBe(500)
      expect(db.documentProcessingJob.deleteMany).not.toHaveBeenCalled()
      expect(db.knowledgeDocument.deleteMany).not.toHaveBeenCalled()
      expect(db.knowledgeFolder.deleteMany).not.toHaveBeenCalled()
      expect(db.knowledgeBase.delete).not.toHaveBeenCalled()
    }
  )

  it("includes historical soft-deleted descendants when permanently deleting a folder", async () => {
    db.knowledgeFolder.findMany
      .mockResolvedValueOnce([{ id: childId, deletedAt: new Date() }])
      .mockResolvedValueOnce([])
    db.knowledgeDocument.findMany.mockResolvedValue([
      { ...document, deletedAt: new Date() },
    ])
    expect(
      (
        await app.request(`/folders/${folderId}?recursive=true`, {
          method: "DELETE",
        })
      ).status
    ).toBe(200)
    expect(db.knowledgeFolder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { knowledgeBaseId: baseId, parentId: { in: [folderId] } },
      })
    )
    expect(db.knowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { folderId: { in: [folderId, childId] } },
      })
    )
    expect(db.knowledgeDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [id] } },
    })
  })

  it.each([`/folders/${folderId}?recursive=true`, `/bases/${baseId}`])(
    "requires authentication for %s",
    async (path) => {
      login.authenticated = false
      expect((await app.request(path, { method: "DELETE" })).status).toBe(401)
      expect(db.$transaction).not.toHaveBeenCalled()
    }
  )

  it("cannot delete another user's folder or base", async () => {
    db.knowledgeFolder.findFirst.mockResolvedValue(null)
    db.knowledgeBase.findFirst.mockResolvedValue(null)
    expect(
      (
        await app.request(`/folders/${folderId}?recursive=true`, {
          method: "DELETE",
        })
      ).status
    ).toBe(404)
    expect(
      (await app.request(`/bases/${baseId}`, { method: "DELETE" })).status
    ).toBe(404)
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
    expect(db.knowledgeBase.update).not.toHaveBeenCalled()
    expect(db.knowledgeDocument.deleteMany).not.toHaveBeenCalled()
    expect(db.knowledgeFolder.deleteMany).not.toHaveBeenCalled()
    expect(db.knowledgeBase.delete).not.toHaveBeenCalled()
  })

  it.each([`/folders/${folderId}?recursive=true`, `/bases/${baseId}`])(
    "does not delete metadata without a durable cleanup record for %s",
    async (path) => {
      db.documentProcessingJob.createMany.mockRejectedValue(
        new Error("database unavailable")
      )
      expect((await app.request(path, { method: "DELETE" })).status).toBe(500)
      expect(db.knowledgeFolder.deleteMany).not.toHaveBeenCalled()
      expect(db.knowledgeDocument.deleteMany).not.toHaveBeenCalled()
      expect(db.knowledgeBase.update).not.toHaveBeenCalled()
    }
  )
})
