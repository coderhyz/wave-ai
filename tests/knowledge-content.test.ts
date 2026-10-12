/** P2-b 保存回归：执行真实路由与服务，模拟数据库，不连接实际用户数据。 */
import { Hono, type Context, type Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { knowledgeDocumentRoute } from "@/app/api/[[...route]]/knowledge-document"
import { saveKnowledgeDocumentContent } from "@/lib/knowledge/document-service"
import { MAX_MARKDOWN_CHARACTERS } from "@/lib/knowledge/parsers/types"

const { db, login } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    knowledgeBase: { findFirst: vi.fn() },
    knowledgeDocument: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
  login: { authenticated: true },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/hono/hono-middware", () => ({
  getAuthUser: async (c: Context, next: Next) => {
    if (!login.authenticated)
      throw new HTTPException(401, { message: "未认证" })
    c.set("user", { id: "owner" })
    await next()
  },
}))

const id = "10000000-0000-4000-8000-000000000001"
const document = {
  id,
  knowledgeBaseId: "base-id",
  status: "READY",
  markdownContent: "# 旧标题",
  contentRevision: 4,
  revision: 7,
  parseMetadata: {
    provider: "mineru",
    assetNames: ["image.png"],
    sections: [{ locator: { page: 2 } }],
  },
}
const input = {
  markdownContent: "# 新标题\r\n\r\n正文",
  expectedContentRevision: 4,
}

const app = new Hono()
  .route("/documents", knowledgeDocumentRoute)
  .onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "internal error" }, 500)
  )
function request(json: unknown = input, documentId = id) {
  return app.request(`/documents/${documentId}/content`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  login.authenticated = true
  db.$transaction.mockImplementation((callback) => callback(db))
  db.knowledgeBase.findFirst.mockResolvedValue({ id: document.knowledgeBaseId })
  db.knowledgeDocument.findFirst.mockResolvedValue(document)
  db.knowledgeDocument.updateMany.mockResolvedValue({ count: 1 })
  db.knowledgeDocument.findUniqueOrThrow.mockResolvedValue({
    ...document,
    markdownContent: "# 新标题\n\n正文",
    contentRevision: 5,
    revision: 8,
  })
})

describe("knowledge content save", () => {
  it("updates canonical body and derived fields while preserving originals and assets", async () => {
    const saved = await saveKnowledgeDocumentContent("owner", id, input)
    expect(saved.contentRevision).toBe(5)
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: {
        id,
        deletedAt: null,
        knowledgeBase: { userId: "owner", deletedAt: null },
        status: "READY",
        contentRevision: 4,
      },
      data: {
        markdownContent: "# 新标题\n\n正文",
        plainText: "新标题\n\n正文",
        parseMetadata: {
          provider: "mineru",
          assetNames: ["image.png"],
          sections: [
            {
              startOffset: 0,
              endOffset: 9,
              locator: { headingPath: ["新标题"] },
            },
          ],
        },
        revision: { increment: 1 },
        contentRevision: { increment: 1 },
        chunkStatus: "PENDING",
        chunkedContentRevision: null,
      },
    })
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" })
    )
  })

  it("supports an intentionally empty body", async () => {
    await saveKnowledgeDocumentContent("owner", id, {
      ...input,
      markdownContent: "",
    })
    expect(db.knowledgeDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          markdownContent: "",
          plainText: "",
          parseMetadata: expect.objectContaining({ sections: [] }),
        }),
      })
    )
  })

  it("rejects a document not owned by the current user", async () => {
    db.knowledgeDocument.findFirst.mockResolvedValue(null)
    const response = await request()
    expect(response.status).toBe(404)
    expect(db.knowledgeDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id,
          deletedAt: null,
          knowledgeBase: { userId: "owner", deletedAt: null },
        },
      })
    )
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it("rechecks the document after waiting for the deletion lock", async () => {
    db.knowledgeDocument.findFirst
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce(null)
    expect((await request()).status).toBe(404)
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it("fails when the knowledge base was deleted while waiting", async () => {
    db.knowledgeBase.findFirst.mockResolvedValue(null)
    expect((await request()).status).toBe(404)
    expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
  })

  it.each(["QUEUED", "PARSING", "FAILED"])(
    "does not save a %s document",
    async (status) => {
      db.knowledgeDocument.findFirst.mockResolvedValue({ ...document, status })
      const response = await request()
      expect(response.status).toBe(409)
      expect((await response.json()).error.code).toBe(
        "KNOWLEDGE_DOCUMENT_NOT_READY"
      )
      expect(db.knowledgeDocument.updateMany).not.toHaveBeenCalled()
    }
  )

  it("returns a visible 409 instead of overwriting a stale revision", async () => {
    db.knowledgeDocument.updateMany.mockResolvedValue({ count: 0 })
    const response = await request()
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("CONTENT_REVISION_CONFLICT")
    expect(db.knowledgeDocument.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it("only permits one of two saves carrying the same revision", async () => {
    // 模拟 UPDATE 的比较并交换，验证服务确实把版本放入写入条件，而非只做预检查。
    let version = 4
    db.knowledgeDocument.updateMany.mockImplementation(({ where }) => {
      if (where.contentRevision !== version) return { count: 0 }
      version += 1
      return { count: 1 }
    })
    const results = await Promise.allSettled([
      saveKnowledgeDocumentContent("owner", id, input),
      saveKnowledgeDocumentContent("owner", id, {
        ...input,
        markdownContent: "另一个标签页",
      }),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    expect(version).toBe(5)
  })

  it("returns the saved document through the existing response contract", async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      document: { id, contentRevision: 5 },
    })
  })

  it("requires authentication", async () => {
    login.authenticated = false
    expect((await request()).status).toBe(401)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    { markdownContent: "text" },
    { ...input, expectedContentRevision: -1 },
    { ...input, expectedContentRevision: 1.5 },
    { ...input, markdownContent: "x".repeat(MAX_MARKDOWN_CHARACTERS + 1) },
    { ...input, userId: "another-user" },
  ])("validates the external body once at the HTTP boundary", async (json) => {
    expect((await request(json)).status).toBe(400)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("rejects an invalid document ID before touching the database", async () => {
    expect((await request(input, "invalid-id")).status).toBe(400)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("does not manufacture success when the database fails", async () => {
    db.knowledgeDocument.updateMany.mockRejectedValue(
      new Error("database unavailable")
    )
    expect((await request()).status).toBe(500)
    expect(db.knowledgeDocument.findUniqueOrThrow).not.toHaveBeenCalled()
  })
})
