import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  index: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({
  default: {
    knowledgeDocument: { findMany: mocks.find },
    $disconnect: mocks.disconnect,
  },
}))
vi.mock("@/lib/knowledge/documents/process-document", () => ({
  indexKnowledgeDocument: mocks.index,
}))
const documents = [
  { id: "first", contentRevision: 4, knowledgeBase: { userId: "owner-a" } },
  { id: "second", contentRevision: 7, knowledgeBase: { userId: "owner-b" } },
]
const originalExitCode = process.exitCode
let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let errorLog: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.exitCode = originalExitCode
  mocks.find.mockReset().mockResolvedValue(documents)
  mocks.index.mockReset().mockResolvedValue({})
  mocks.disconnect.mockReset().mockResolvedValue(undefined)
  log = vi.spyOn(console, "log").mockImplementation(() => {})
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})
const run = () => import("@/workers/reindex-documents")

describe("direct reindex command", () => {
  it("awaits each actual index completion with its owner and revision", async () => {
    const first = Promise.withResolvers<void>()
    mocks.index.mockReturnValueOnce(first.promise)
    let settled = false
    const pending = run().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(mocks.index).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    expect(mocks.index).toHaveBeenCalledWith({
      userId: "owner-a",
      documentId: "first",
      contentRevision: 4,
      signal: expect.any(AbortSignal),
    })
    first.resolve()
    await pending
    expect(mocks.index).toHaveBeenCalledTimes(2)
    expect(mocks.index).toHaveBeenLastCalledWith({
      userId: "owner-b",
      documentId: "second",
      contentRevision: 7,
      signal: expect.any(AbortSignal),
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2"))
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(originalExitCode)
  })
  it("reports real failures, processes other documents and exits unsuccessfully", async () => {
    const error = new Error("Embedding unavailable")
    mocks.index.mockRejectedValueOnce(error)
    await run()
    expect(mocks.index).toHaveBeenCalledTimes(2)
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("first"),
      error
    )
    expect(process.exitCode).toBe(1)
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
  it.each([404, 409] as const)(
    "reports and skips a deleted, changed or active document (%s)",
    async (status) => {
      const { KnowledgeError } = await import("@/lib/knowledge/errors")
      mocks.index.mockRejectedValueOnce(
        new KnowledgeError(
          status === 404
            ? "KNOWLEDGE_DOCUMENT_NOT_FOUND"
            : "CONTENT_REVISION_CONFLICT",
          "Changed",
          status
        )
      )
      await run()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("first"))
      expect(mocks.index).toHaveBeenCalledTimes(2)
      expect(process.exitCode).toBe(originalExitCode)
    }
  )
  it("propagates candidate lookup errors and always disconnects", async () => {
    const error = new Error("Database unavailable")
    mocks.find.mockRejectedValue(error)
    await expect(run()).rejects.toBe(error)
    expect(mocks.index).not.toHaveBeenCalled()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
  it("aborts the active index and does not start the next document on shutdown", async () => {
    const listeners = process.listeners("SIGINT")
    mocks.index.mockImplementationOnce(
      async ({ signal }: { signal: AbortSignal }) => {
        const stop = process
          .listeners("SIGINT")
          .find((listener) => !listeners.includes(listener))
        expect(stop).toBeDefined()
        stop!("SIGINT")
        signal.throwIfAborted()
      }
    )
    await expect(run()).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.index).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(process.listeners("SIGINT")).toEqual(listeners)
  })
})
