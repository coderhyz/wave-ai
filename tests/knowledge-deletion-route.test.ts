import { beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { knowledgeBaseRoute } from "@/app/api/[[...route]]/knowledge-base"
import { knowledgeFolderRoute } from "@/app/api/[[...route]]/knowledge-folder"
import { knowledgeDocumentRoute } from "@/app/api/[[...route]]/knowledge-document"
import { KnowledgeError } from "@/lib/knowledge/errors"

const mocks = vi.hoisted(() => ({
  removeDocument: vi.fn(),
  removeFolder: vi.fn(),
  removeBase: vi.fn(),
  authenticated: true,
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/knowledge/documents/document-service", () => ({}))
vi.mock("@/lib/knowledge/management/service", () => ({
  deleteKnowledgeDocument: mocks.removeDocument,
  deleteKnowledgeFolder: mocks.removeFolder,
  deleteKnowledgeBase: mocks.removeBase,
}))
vi.mock("@/lib/hono/hono-middware", () => ({
  getAuthUser: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>
  ) => {
    if (!mocks.authenticated) throw new HTTPException(401)
    c.set("user", { id: "owner" })
    await next()
  },
}))
const app = new Hono()
  .route("/knowledge-bases", knowledgeBaseRoute)
  .route("/knowledge-folders", knowledgeFolderRoute)
  .route("/knowledge-documents", knowledgeDocumentRoute)
const id = "aa000000-0000-4000-8000-000000000001"
const resources = [
  {
    name: "document",
    path: `/knowledge-documents/${id}`,
    remove: mocks.removeDocument,
  },
  {
    name: "folder",
    path: `/knowledge-folders/${id}?recursive=true`,
    remove: mocks.removeFolder,
  },
  { name: "base", path: `/knowledge-bases/${id}`, remove: mocks.removeBase },
]
const deleted = {
  id,
  knowledgeBaseId: "base",
  documentIds: [id],
  folderIds: [],
  cleanup: { completed: 3, failed: 0, pending: 0 },
}
beforeEach(() => {
  mocks.authenticated = true
  for (const resource of resources)
    resource.remove.mockReset().mockResolvedValue(deleted)
})
describe.each(resources)(
  "$name deletion HTTP contract",
  ({ name, path, remove }) => {
    const request = () => app.request(path, { method: "DELETE" })
    it("reports success only after all resources are cleaned", async () => {
      const response = await request()
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
      expect((name === "document" ? data : data.deleted).cleanup).toEqual(
        deleted.cleanup
      )
      expect(remove).toHaveBeenCalledWith(
        "owner",
        id,
        ...(name === "folder" ? [true] : [])
      )
    })
    it.each(["failed", "pending"])(
      "reports a partial deletion explicitly when cleanup is %s",
      async (state) => {
        remove.mockResolvedValue({
          ...deleted,
          cleanup: {
            completed: 2,
            failed: state === "failed" ? 1 : 0,
            pending: state === "pending" ? 1 : 0,
          },
        })
        const response = await request()
        expect(response.status).toBe(207)
        const data = await response.json()
        expect(data.success).toBe(false)
        expect((name === "document" ? data : data.deleted).cleanup[state]).toBe(
          1
        )
      }
    )
    it("preserves a busy-state conflict instead of pretending deletion succeeded", async () => {
      remove.mockRejectedValue(
        new KnowledgeError(
          "KNOWLEDGE_DOCUMENT_PROCESSING",
          "Still processing",
          409
        )
      )
      const response = await request()
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: { code: "KNOWLEDGE_DOCUMENT_PROCESSING" },
      })
    })
    it("authenticates before any delete or cleanup", async () => {
      mocks.authenticated = false
      expect((await request()).status).toBe(401)
      expect(remove).not.toHaveBeenCalled()
    })
  }
)
