import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  MutationObserver,
  QueryClient,
  useMutation,
} from "@tanstack/react-query"
import { fetchWithAuth } from "@/lib/hono/hono-rpc"
import {
  KnowledgeRequestError,
  useUploadKnowledgeDocument,
  useReparseKnowledgeDocument,
} from "@/hooks/use-knowledge"

const state = vi.hoisted(() => ({
  client: undefined as QueryClient | undefined,
  reparse: vi.fn(),
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: vi.fn((options) => options),
  useQueryClient: () => state.client,
}))
vi.mock("@/lib/hono/hono-rpc", () => ({
  api: {
    "knowledge-bases": {},
    "knowledge-documents": { ":id": { reparse: { $post: state.reparse } } },
    "knowledge-folders": {},
  },
  fetchWithAuth: vi.fn(),
}))

const variables = { file: new File(["content"], "source.md"), folderId: null }
const terminal = {
  success: true,
  document: {
    id: "document",
    knowledgeBaseId: "base",
    status: "READY",
    chunkStatus: "READY",
  },
}
function UploadMutationProbe() {
  useUploadKnowledgeDocument("base")
  return null
}
function ReparseMutationProbe() {
  useReparseKnowledgeDocument("document")
  return null
}
function observer(reparse = false) {
  renderToString(
    createElement(reparse ? ReparseMutationProbe : UploadMutationProbe)
  )
  const options = vi.mocked(useMutation).mock.calls.at(-1)![0]
  return new MutationObserver(state.client!, options)
}
beforeEach(() => {
  vi.clearAllMocks()
  state.reparse
    .mockReset()
    .mockResolvedValue(
      Response.json({
        ...terminal,
        document: { ...terminal.document, contentRevision: 5 },
      })
    )
  state.client = new QueryClient({
    defaultOptions: { mutations: { retry: 2 } },
  })
  vi.mocked(fetchWithAuth)
    .mockReset()
    .mockResolvedValue(Response.json(terminal, { status: 201 }))
})

describe("upload mutation", () => {
  it("stays pending until the response and writes terminal detail to cache", async () => {
    const response = Promise.withResolvers<Response>()
    vi.mocked(fetchWithAuth).mockReturnValue(response.promise)
    const invalidated = vi.spyOn(state.client!, "invalidateQueries")
    const mutation = observer()
    const pending = mutation.mutate(variables)
    await vi.waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(mutation.getCurrentResult().isPending).toBe(true)
    response.resolve(Response.json(terminal, { status: 201 }))
    await pending
    expect(
      state.client!.getQueryData(["knowledge-document", "document"])
    ).toEqual(terminal)
    expect(invalidated).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base"],
    })
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["knowledge-bases"] })
    expect(mutation.getCurrentResult().isSuccess).toBe(true)
  })
  it("preserves failure details, refreshes saved documents, and never retries upload", async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      Response.json(
        {
          error: {
            message: "Index failed",
            details: { documentId: "document", phase: "index" },
          },
        },
        { status: 502 }
      )
    )
    const invalidated = vi.spyOn(state.client!, "invalidateQueries")
    const mutation = observer()
    await expect(mutation.mutate(variables)).rejects.toMatchObject({
      status: 502,
      details: { documentId: "document", phase: "index" },
    })
    expect(fetchWithAuth).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledWith({
      queryKey: ["knowledge-document", "document"],
    })
    expect(invalidated).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base"],
    })
    expect(
      state.client!.getQueryData(["knowledge-document", "document"])
    ).toBeUndefined()
  })
  it("refreshes the tree after an uncertain network failure without resubmitting", async () => {
    const error = new TypeError("Connection lost")
    vi.mocked(fetchWithAuth).mockRejectedValue(error)
    const invalidated = vi.spyOn(state.client!, "invalidateQueries")
    await expect(observer().mutate(variables)).rejects.toBe(error)
    expect(fetchWithAuth).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base"],
    })
  })
  it("keeps plain HTTP errors readable", async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    )
    await expect(observer().mutate(variables)).rejects.toBeInstanceOf(
      KnowledgeRequestError
    )
  })
})

describe("reparse mutation", () => {
  const revision = { expectedContentRevision: 4 }
  it("waits for actual completion and replaces cached detail with the final revision", async () => {
    const response = Promise.withResolvers<Response>()
    state.reparse.mockReturnValue(response.promise)
    const invalidated = vi.spyOn(state.client!, "invalidateQueries")
    const mutation = observer(true)
    const pending = mutation.mutate(revision)
    await vi.waitFor(() => expect(state.reparse).toHaveBeenCalledTimes(1))
    expect(mutation.getCurrentResult().isPending).toBe(true)
    response.resolve(
      Response.json({
        ...terminal,
        document: { ...terminal.document, contentRevision: 5 },
      })
    )
    await pending
    expect(state.reparse).toHaveBeenCalledWith({
      param: { id: "document" },
      json: revision,
    })
    expect(
      state.client!.getQueryData(["knowledge-document", "document"])
    ).toMatchObject({ document: { contentRevision: 5, chunkStatus: "READY" } })
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["knowledge-tree"] })
  })
  it.each([409, 502])(
    "refreshes detail and tree after failure %s without an automatic retry",
    async (status) => {
      const previous = {
        ...terminal,
        document: {
          ...terminal.document,
          contentRevision: 4,
          markdownContent: "Old saved body",
        },
      }
      state.client!.setQueryData(["knowledge-document", "document"], previous)
      state.reparse.mockResolvedValue(
        Response.json(
          {
            error: {
              message: "Reparse failed",
              details: { documentId: "document", phase: "parse" },
            },
          },
          { status }
        )
      )
      const invalidated = vi.spyOn(state.client!, "invalidateQueries")
      await expect(observer(true).mutate(revision)).rejects.toMatchObject({
        status,
      })
      expect(state.reparse).toHaveBeenCalledTimes(1)
      expect(invalidated).toHaveBeenCalledWith({
        queryKey: ["knowledge-document", "document"],
      })
      expect(invalidated).toHaveBeenCalledWith({ queryKey: ["knowledge-tree"] })
      expect(
        state.client!.getQueryData(["knowledge-document", "document"])
      ).toEqual(previous)
      expect(
        state.client!.getQueryState(["knowledge-document", "document"])
          ?.isInvalidated
      ).toBe(true)
    }
  )
})
