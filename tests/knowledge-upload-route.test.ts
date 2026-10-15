import { beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { knowledgeDocumentRoute } from "@/app/api/[[...route]]/knowledge-document"
import { knowledgeBaseRoute } from "@/app/api/[[...route]]/knowledge-base"
import { KnowledgeError } from "@/lib/knowledge/errors"

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  reparse: vi.fn(),
  authenticated: true,
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/knowledge/documents/document-service", () => ({
  createKnowledgeDocumentUpload: mocks.upload,
  reparseKnowledgeDocument: mocks.reparse,
}))
vi.mock("@/lib/knowledge/management/service", () => ({}))
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
  .route("/knowledge-documents", knowledgeDocumentRoute)
const baseId = "aa000000-0000-4000-8000-000000000001"
const document = {
  id: "document",
  knowledgeBaseId: baseId,
  status: "READY",
  chunkStatus: "READY",
}
function request(
  options: {
    file?: boolean
    folderId?: string
    contentLength?: string
    signal?: AbortSignal
  } = {}
) {
  const form = new FormData()
  if (options.file !== false)
    form.set(
      "file",
      new File(["# Content"], "source.md", { type: "text/markdown" })
    )
  if (options.folderId) form.set("folderId", options.folderId)
  return new Request(`http://localhost/knowledge-bases/${baseId}/documents`, {
    method: "POST",
    body: form,
    signal: options.signal,
    headers: options.contentLength
      ? { "content-length": options.contentLength }
      : undefined,
  })
}
beforeEach(() => {
  mocks.authenticated = true
  mocks.upload.mockReset().mockResolvedValue(document)
  mocks.reparse
    .mockReset()
    .mockResolvedValue({ ...document, contentRevision: 5 })
})
describe("upload HTTP contract", () => {
  it("returns 201 only after processing completes and forwards the request signal", async () => {
    const done = Promise.withResolvers<typeof document>()
    mocks.upload.mockReturnValue(done.promise)
    const controller = new AbortController()
    const req = request({ signal: controller.signal })
    let settled = false
    const pending = Promise.resolve(app.fetch(req)).then((response) => {
      settled = true
      return response
    })
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalled())
    expect(settled).toBe(false)
    const input = mocks.upload.mock.calls[0][0]
    expect(input).toMatchObject({
      userId: "owner",
      knowledgeBaseId: baseId,
      folderId: null,
      filename: "source.md",
    })
    expect(input.buffer.toString()).toBe("# Content")
    expect(input.signal).toBe(req.signal)
    done.resolve(document)
    const response = await pending
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ success: true, document })
  })
  it("returns a non-success response with the persisted document ID and failed stage", async () => {
    mocks.upload.mockRejectedValue(
      new KnowledgeError(
        "KNOWLEDGE_DOCUMENT_PROCESSING_FAILED",
        "Index failed",
        502,
        { documentId: "document", phase: "index" }
      )
    )
    const response = await app.fetch(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { details: { documentId: "document", phase: "index" } },
    })
  })
  it("requires authentication before accepting the upload", async () => {
    mocks.authenticated = false
    expect((await app.fetch(request())).status).toBe(401)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it.each([
    { options: { file: false }, status: 400 },
    { options: { folderId: "invalid" }, status: 400 },
    { options: { contentLength: String(22 * 1024 * 1024) }, status: 413 },
  ])("keeps multipart validation ($status)", async ({ options, status }) => {
    expect((await app.fetch(request(options))).status).toBe(status)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})

describe("reparse HTTP contract", () => {
  const json = { expectedContentRevision: 4 }
  function reparseRequest(body: unknown = json, signal?: AbortSignal) {
    return new Request(
      `http://localhost/knowledge-documents/${baseId}/reparse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }
    )
  }
  it("returns 200 only after the confirmed version is processed and forwards cancellation", async () => {
    const done = Promise.withResolvers<
      typeof document & { contentRevision: number }
    >()
    mocks.reparse.mockReturnValue(done.promise)
    const req = reparseRequest(json, new AbortController().signal)
    let settled = false
    const pending = Promise.resolve(app.fetch(req)).then((response) => {
      settled = true
      return response
    })
    await vi.waitFor(() => expect(mocks.reparse).toHaveBeenCalled())
    expect(settled).toBe(false)
    expect(mocks.reparse).toHaveBeenCalledWith(
      "owner",
      baseId,
      json,
      req.signal
    )
    done.resolve({ ...document, contentRevision: 5 })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      document: { contentRevision: 5, chunkStatus: "READY" },
    })
  })
  it.each([409, 502] as const)(
    "keeps a %s failure non-successful",
    async (status) => {
      mocks.reparse.mockRejectedValue(
        new KnowledgeError(
          status === 409
            ? "CONTENT_REVISION_CONFLICT"
            : "KNOWLEDGE_DOCUMENT_PROCESSING_FAILED",
          "Failed",
          status,
          { documentId: baseId, phase: "index" }
        )
      )
      const response = await app.fetch(reparseRequest())
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({
        error: { message: "Failed" },
      })
    }
  )
  it.each([
    {},
    { expectedContentRevision: -1 },
    { expectedContentRevision: "4" },
    { ...json, extra: true },
  ])("validates the revision at the HTTP boundary", async (body) => {
    expect((await app.fetch(reparseRequest(body))).status).toBe(400)
    expect(mocks.reparse).not.toHaveBeenCalled()
  })
  it("requires authentication", async () => {
    mocks.authenticated = false
    expect((await app.fetch(reparseRequest())).status).toBe(401)
    expect(mocks.reparse).not.toHaveBeenCalled()
  })
})
