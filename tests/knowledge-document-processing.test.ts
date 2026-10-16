import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@/app/generated/prisma"
import {
  processKnowledgeDocument,
  parseKnowledgeDocument,
  indexKnowledgeDocument,
} from "@/lib/knowledge/documents/process-document"
import {
  reparseKnowledgeDocument,
  createKnowledgeDocumentUpload,
} from "@/lib/knowledge/documents/document-service"
import { KnowledgeParseError } from "@/lib/knowledge/parsers/types"
import { KnowledgeError } from "@/lib/knowledge/errors"
import { markdownParser } from "@/lib/knowledge/parsers/markdown-pass-through"
import { txtParser } from "@/lib/knowledge/parsers/txt-to-markdown"
import type { KnowledgeDocumentParser } from "@/lib/knowledge/parsers/types"

const mocks = vi.hoisted(() => ({
  runCleanup: vi.fn(),
  create: vi.fn(),
  jobCreate: vi.fn(),
  remove: vi.fn(),
  ownedBase: vi.fn(),
  ownedFolder: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  cleanup: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  parser: vi.fn(),
  embed: vi.fn(),
  es: vi.fn(),
  replace: vi.fn(),
  lock: vi.fn(),
  registerCleanup: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({
  default: {
    knowledgeDocument: {
      create: mocks.create,
      findFirst: mocks.find,
      updateMany: mocks.update,
    },
    documentProcessingJob: {
      create: mocks.jobCreate,
      createMany: mocks.cleanup,
    },
    $transaction: mocks.transaction,
  },
}))
vi.mock("@/lib/knowledge/documents/cleanup", () => ({
  cleanupKnowledgeResources: mocks.runCleanup,
  deleteKnowledgeCleanupResource: vi.fn(),
}))
vi.mock("@/lib/storage/oss", () => ({
  getOssObject: mocks.get,
  putOssObject: mocks.put,
  deleteOssObject: mocks.remove,
  getOssPreviewUrl: vi.fn(),
}))
vi.mock("@/lib/knowledge/ownership", () => ({
  lockOwnedKnowledgeBase: mocks.lock,
  requireOwnedKnowledgeBase: mocks.ownedBase,
  requireFolderInKnowledgeBase: mocks.ownedFolder,
}))
vi.mock("@/lib/knowledge/management/service", () => ({
  registerCleanupJobs: mocks.registerCleanup,
}))
vi.mock("@/lib/knowledge/parsers/registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/knowledge/parsers/registry")
  >()),
  getKnowledgeParser: mocks.parser,
}))
vi.mock("@/lib/knowledge/indexing/embedding", () => ({
  embedDocumentChunks: mocks.embed,
}))
vi.mock("@/lib/knowledge/indexing/indexing", () => ({
  replaceDocumentChunks: mocks.replace,
}))
vi.mock("@/lib/es/knowledge-index", () => ({
  indexKnowledgeChunks: mocks.es,
  deleteKnowledgeChunks: vi.fn(),
}))

const source = Buffer.from("# Original\n\nA real paragraph.")
const input = { userId: "owner", documentId: "document" }
function initialDocument() {
  return {
    id: input.documentId,
    knowledgeBaseId: "base",
    title: "document",
    type: "MARKDOWN",
    originalFileName: "source.md",
    mimeType: "text/markdown",
    sizeBytes: source.length,
    checksumSha256: createHash("sha256").update(source).digest("hex"),
    storageKey: "original",
    parseMetadata: {} as Prisma.JsonValue,
    contentRevision: 0,
    status: "QUEUED",
    deletedAt: null as Date | null,
    markdownContent: null as string | null,
    chunkStatus: "PENDING",
    chunkedContentRevision: null as number | null,
    parseErrorCode: null as string | null,
    parseErrorMessage: null as string | null,
    chunkErrorMessage: null as string | null,
    knowledgeBase: { userId: input.userId },
  }
}
let document = initialDocument()
let events: string[] = []
const db = {
  knowledgeDocument: {
    create: mocks.create,
    findFirst: mocks.find,
    updateMany: mocks.update,
  },
}
const assetParser: KnowledgeDocumentParser = {
  kind: "pdf",
  version: "test",
  async parse(_buffer, context) {
    const url = await context.uploadAsset?.({
      data: Buffer.from("image"),
      mediaType: "image/png",
    })
    return {
      markdown: `![image](${url})`,
      metadata: {},
      sections: [],
      warnings: [],
    }
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  mocks.runCleanup
    .mockReset()
    .mockResolvedValue({ completed: 0, failed: 0, pending: 0 })
  mocks.create.mockReset().mockImplementation(async ({ data }) => {
    Object.assign(document, data)
    return { id: document.id }
  })
  mocks.jobCreate.mockReset().mockResolvedValue({})
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.ownedBase.mockReset().mockResolvedValue({})
  mocks.ownedFolder.mockReset().mockResolvedValue({})
  document = initialDocument()
  events = []
  mocks.find
    .mockReset()
    .mockImplementation(
      async ({
        where,
      }: {
        where: { id: string; knowledgeBase?: { userId?: string } }
      }) =>
        where.id === document.id &&
        !document.deletedAt &&
        (!where.knowledgeBase?.userId ||
          where.knowledgeBase.userId === input.userId)
          ? structuredClone(document)
          : null
    )
  mocks.update
    .mockReset()
    .mockImplementation(
      async ({ where = {}, data }: Prisma.KnowledgeDocumentUpdateManyArgs) => {
        if (
          (typeof where.status === "object" &&
            (where.status.not === document.status ||
              (Array.isArray(where.status.in) &&
                !where.status.in.includes(document.status as "READY")))) ||
          (typeof where.chunkStatus === "object" &&
            where.chunkStatus.not === document.chunkStatus) ||
          where.id !== document.id ||
          document.deletedAt ||
          (typeof where.contentRevision === "number" &&
            where.contentRevision !== document.contentRevision) ||
          (typeof where.status === "string" &&
            where.status !== document.status) ||
          (typeof where.chunkStatus === "string" &&
            where.chunkStatus !== document.chunkStatus)
        )
          return { count: 0 }
        const revision = data.contentRevision
        const update = { ...data }
        if (
          revision &&
          typeof revision === "object" &&
          typeof revision.increment === "number"
        )
          update.contentRevision = document.contentRevision + revision.increment
        Object.assign(document, update)
        return { count: 1 }
      }
    )
  // Roll back the document snapshot when a transaction fails, including cancellation.
  mocks.transaction
    .mockReset()
    .mockImplementation(
      async (callback: (transaction: typeof db) => Promise<unknown>) => {
        const snapshot = structuredClone(document)
        try {
          return await callback(db)
        } catch (error) {
          document = snapshot
          throw error
        }
      }
    )
  mocks.parser
    .mockReset()
    .mockImplementation((kind: string) =>
      kind === "markdown" ? markdownParser : txtParser
    )
  mocks.get.mockReset().mockResolvedValue(source)
  mocks.put.mockReset().mockResolvedValue(undefined)
  mocks.embed.mockReset().mockImplementation(async () => {
    events.push("embedding")
    return { embeddings: [[1, 2]], embeddingModel: "test-embedding" }
  })
  mocks.es.mockReset().mockImplementation(async () => {
    events.push("es")
  })
  mocks.replace.mockReset().mockImplementation(async () => {
    events.push("pg")
  })
  mocks.cleanup.mockReset().mockResolvedValue({ count: 1 })
  mocks.lock.mockReset().mockResolvedValue(undefined)
  mocks.registerCleanup.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("direct document processing", () => {
  it.each(["MARKDOWN", "TEXT"])(
    "processes %s to searchable content in one call without claiming a job",
    async (type) => {
      document.type = type
      const result = await processKnowledgeDocument(input)
      expect(result).toMatchObject({ id: "document", contentRevision: 1 })
      expect(document).toMatchObject({
        status: "READY",
        chunkStatus: "READY",
        chunkedContentRevision: 1,
      })
      expect(document.markdownContent).toContain("A real paragraph.")
      expect(events).toEqual(["embedding", "es", "pg"])
      expect(mocks.embed.mock.calls[0][0].abortSignal).toBeInstanceOf(
        AbortSignal
      )
      expect(mocks.es.mock.calls[0][0].abortSignal).toBe(
        mocks.embed.mock.calls[0][0].abortSignal
      )
    }
  )

  it("still validates an explicitly provided source against the stored checksum", async () => {
    await expect(
      processKnowledgeDocument({ ...input, source: Buffer.from("altered") })
    ).rejects.toMatchObject({
      code: "FILE_SIGNATURE_MISMATCH",
    })
    expect(document.status).toBe("FAILED")
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.parser).not.toHaveBeenCalled()
  })

  it("rejects concurrent direct parsing without failing the active operation", async () => {
    const read = Promise.withResolvers<Buffer>()
    mocks.get.mockReturnValue(read.promise)
    const first = parseKnowledgeDocument(input)
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled())
    await expect(parseKnowledgeDocument(input)).rejects.toMatchObject({
      code: "CONTENT_REVISION_CONFLICT",
    })
    expect(document.status).toBe("PARSING")
    read.resolve(source)
    await first
    expect(document.status).toBe("READY")
  })

  it("rejects concurrent direct indexing without overwriting its active status", async () => {
    document.status = "READY"
    document.markdownContent = source.toString()
    const embeddings = Promise.withResolvers<{
      embeddings: number[][]
      embeddingModel: string
    }>()
    mocks.embed.mockReturnValue(embeddings.promise)
    const first = indexKnowledgeDocument({ ...input, contentRevision: 0 })
    await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalled())
    await expect(
      indexKnowledgeDocument({ ...input, contentRevision: 0 })
    ).rejects.toMatchObject({ code: "CONTENT_REVISION_CONFLICT" })
    expect(document.chunkStatus).toBe("RUNNING")
    embeddings.resolve({ embeddings: [[1, 2]], embeddingModel: "test" })
    await first
    expect(document.chunkStatus).toBe("READY")
  })

  it.each(["parse", "index"])(
    "records a readable %s failure when the request aborts without a message",
    async (stage) => {
      const controller = new AbortController()
      const reason = Object.assign(new Error(), { name: "ResponseAborted" })
      const blocked = Promise.withResolvers<never>()
      if (stage === "parse") {
        mocks.parser.mockReturnValue({
          ...assetParser,
          parse: () => blocked.promise,
        })
      } else {
        mocks.embed.mockReturnValue(blocked.promise)
      }
      const pending = processKnowledgeDocument({
        ...input,
        signal: controller.signal,
      })
      const rejected = expect(pending).rejects.toBe(reason)
      await vi.waitFor(() =>
        expect(
          stage === "parse" ? mocks.parser : mocks.embed
        ).toHaveBeenCalled()
      )
      controller.abort(reason)
      await rejected
      if (stage === "parse") {
        expect(document.status).toBe("FAILED")
        expect(document.parseErrorMessage).toBe(
          "解析请求已中断，请重新解析文档"
        )
      } else {
        expect(document.status).toBe("READY")
        expect(document.chunkStatus).toBe("FAILED")
        expect(document.chunkErrorMessage).toBe(
          "索引请求已中断，请重新建立索引"
        )
      }
      expect(mocks.es).not.toHaveBeenCalled()
    }
  )
  it("identifies an empty upstream failure without logging request or response data", async () => {
    const failure = Object.assign(new Error(""), {
      name: "AI_APICallError",
      statusCode: 403,
      cause: new Error("private upstream response"),
      requestBodyValues: {
        apiKey: "private credential",
        input: "private text",
      },
    })
    mocks.embed.mockRejectedValue(failure)
    await expect(processKnowledgeDocument(input)).rejects.toBe(failure)
    expect(document.chunkStatus).toBe("FAILED")
    expect(document.chunkErrorMessage).toContain("向量化（AI_APICallError）")
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "Knowledge document indexing failed",
      {
        documentId: input.documentId,
        stage: "向量化",
        errorName: "AI_APICallError",
        causeName: "Error",
        statusCode: 403,
      }
    )
    expect(mocks.es).not.toHaveBeenCalled()
  })
  it("bounds parsing and records timeout even when a parser ignores cancellation", async () => {
    vi.useFakeTimers()
    const parsed = Promise.withResolvers<{
      markdown: string
      metadata: object
      sections: []
      warnings: []
    }>()
    mocks.parser.mockReturnValue({
      ...assetParser,
      parse: () => parsed.promise,
    })
    const pending = parseKnowledgeDocument({ ...input, timeoutMs: 50 })
    const rejected = expect(pending).rejects.toMatchObject({
      code: "PARSE_TIMEOUT",
    })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(document.status).toBe("FAILED")
    parsed.resolve({
      markdown: "late",
      metadata: {},
      sections: [],
      warnings: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(document.markdownContent).toBeNull()
  })

  it("checks ownership before reading the source or calling external APIs", async () => {
    await expect(
      processKnowledgeDocument({ ...input, userId: "other" })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_DOCUMENT_NOT_FOUND" })
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it("rejects a corrupted source and records a parse failure", async () => {
    mocks.get.mockResolvedValue(Buffer.from("different bytes"))
    await expect(processKnowledgeDocument(input)).rejects.toMatchObject({
      code: "FILE_SIGNATURE_MISMATCH",
    })
    expect(document).toMatchObject({
      status: "FAILED",
      contentRevision: 0,
      parseErrorCode: "FILE_SIGNATURE_MISMATCH",
    })
    expect(mocks.parser).not.toHaveBeenCalled()
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it.each(["embedding", "es"])(
    "keeps parsed content when %s fails",
    async (stage) => {
      const failure = new Error(`${stage} failed`)
      if (stage === "embedding") mocks.embed.mockRejectedValue(failure)
      else mocks.es.mockRejectedValue(failure)
      await expect(processKnowledgeDocument(input)).rejects.toBe(failure)
      expect(document).toMatchObject({
        status: "READY",
        chunkStatus: "FAILED",
        contentRevision: 1,
        chunkedContentRevision: null,
      })
      expect(document.markdownContent).toBe(source.toString())
      expect(mocks.replace).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalledWith(
        "Knowledge document indexing failed",
        expect.objectContaining({
          documentId: input.documentId,
          stage: stage === "embedding" ? "向量化" : "Elasticsearch 写入",
          errorName: "Error",
        })
      )
      if (stage === "embedding") expect(mocks.es).not.toHaveBeenCalled()
    }
  )

  it("rolls back READY when PostgreSQL chunk persistence fails", async () => {
    mocks.replace.mockRejectedValue(new Error("database write failed"))
    await expect(processKnowledgeDocument(input)).rejects.toThrow(
      "database write failed"
    )
    expect(console.error).toHaveBeenCalledWith(
      "Knowledge document indexing failed",
      expect.objectContaining({ stage: "数据库提交" })
    )
    expect(events).toEqual(["embedding", "es"])
    expect(document).toMatchObject({
      status: "READY",
      chunkStatus: "FAILED",
      chunkedContentRevision: null,
    })
  })

  it("does not let a stale version commit after external indexing", async () => {
    mocks.es.mockImplementation(async () => {
      document.contentRevision = 2
    })
    await expect(processKnowledgeDocument(input)).rejects.toMatchObject({
      code: "CONTENT_REVISION_CONFLICT",
    })
    expect(document.contentRevision).toBe(2)
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("stores real image names and retains old-image cleanup", async () => {
    document.parseMetadata = {
      assetNames: ["00000000-0000-0000-0000-000000000000-0001.png"],
    }
    mocks.parser.mockReturnValue(assetParser)
    await parseKnowledgeDocument(input)
    const metadata = document.parseMetadata as { assetNames: string[] }
    expect(metadata.assetNames[0]).toMatch(/^[0-9a-f-]{36}-0001\.png$/)
    expect(document.markdownContent).toContain(metadata.assetNames[0])
    expect(mocks.registerCleanup).toHaveBeenCalledWith(
      db,
      [
        expect.objectContaining({
          storageKey: null,
          parseMetadata: {
            assetNames: ["00000000-0000-0000-0000-000000000000-0001.png"],
          },
        }),
      ],
      "reparse"
    )
  })

  it("cleans generated images if the guarded transaction cannot commit", async () => {
    mocks.parser.mockReturnValue(assetParser)
    const failure = new Error("Commit failed")
    mocks.registerCleanup.mockRejectedValueOnce(failure)
    await expect(parseKnowledgeDocument(input)).rejects.toBe(failure)
    expect(document.markdownContent).toBeNull()
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            type: "CLEANUP",
            payload: expect.objectContaining({ reason: "parse-failed" }),
          }),
        ],
      })
    )
  })

  it("propagates cancellation without work when already aborted", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled")
    controller.abort(reason)
    await expect(
      processKnowledgeDocument({ ...input, signal: controller.signal })
    ).rejects.toBe(reason)
    expect(mocks.find).not.toHaveBeenCalled()
  })

  it("records cancellation promptly and rejects a late non-cancellable source read", async () => {
    const sourceRead = Promise.withResolvers<Buffer>()
    mocks.get.mockReturnValue(sourceRead.promise)
    const controller = new AbortController()
    const pending = parseKnowledgeDocument({
      ...input,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled())
    const reason = new Error("cancelled")
    const rejected = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    expect(document.status).toBe("FAILED")
    sourceRead.resolve(source)
    await Promise.resolve()
    expect(mocks.parser).not.toHaveBeenCalled()
  })

  it("cleans an image that finishes uploading after cancellation", async () => {
    const upload = Promise.withResolvers<void>()
    mocks.put.mockReturnValue(upload.promise)
    mocks.parser.mockReturnValue(assetParser)
    const controller = new AbortController()
    const pending = parseKnowledgeDocument({
      ...input,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalled())
    const rejected = expect(pending).rejects.toThrow("cancelled")
    controller.abort(new Error("cancelled"))
    await Promise.resolve()
    expect(document.status).toBe("PARSING")
    upload.resolve()
    await rejected
    expect(mocks.cleanup).toHaveBeenCalled()
    expect(document.markdownContent).toBeNull()
    expect(document.status).toBe("FAILED")
  })

  it("applies the shared deadline to the index stage and ignores late embeddings", async () => {
    vi.useFakeTimers()
    const embeddings = Promise.withResolvers<{
      embeddings: number[][]
      embeddingModel: string
    }>()
    mocks.embed.mockReturnValue(embeddings.promise)
    const pending = processKnowledgeDocument({ ...input, timeoutMs: 50 })
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(document).toMatchObject({ status: "READY", chunkStatus: "FAILED" })
    embeddings.resolve({ embeddings: [[1, 2]], embeddingModel: "late" })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.es).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("keeps indexing active until an in-flight ES write actually settles after cancellation", async () => {
    document.status = "READY"
    document.markdownContent = source.toString()
    const write = Promise.withResolvers<void>()
    mocks.es.mockReturnValue(write.promise)
    const controller = new AbortController()
    const reason = new DOMException("Cancelled", "AbortError")
    let settled = false
    const pending = indexKnowledgeDocument({
      ...input,
      contentRevision: 0,
      signal: controller.signal,
    })
    const rejected = expect(pending)
      .rejects.toBe(reason)
      .then(() => {
        settled = true
      })
    await vi.waitFor(() => expect(mocks.es).toHaveBeenCalled())
    controller.abort(reason)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(document.chunkStatus).toBe("RUNNING")
    write.resolve()
    await rejected
    expect(document.chunkStatus).toBe("FAILED")
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("checks cancellation inside the commit transaction and rolls back", async () => {
    const controller = new AbortController()
    mocks.registerCleanup.mockImplementationOnce(async () => {
      controller.abort(new Error("cancel during commit"))
    })
    mocks.parser.mockReturnValue(assetParser)
    await expect(
      parseKnowledgeDocument({ ...input, signal: controller.signal })
    ).rejects.toThrow("cancel during commit")
    expect(document.markdownContent).toBeNull()
    expect(mocks.cleanup).toHaveBeenCalledTimes(1)
  })

  it("does not schedule committed images for deletion if cancellation arrives just after commit", async () => {
    const controller = new AbortController()
    mocks.parser.mockReturnValue(assetParser)
    let transactions = 0
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof db) => Promise<unknown>) => {
        const result = await callback(db)
        if (++transactions === 2)
          controller.abort(new Error("cancel after commit"))
        return result
      }
    )
    await expect(
      parseKnowledgeDocument({ ...input, signal: controller.signal })
    ).rejects.toThrow("cancel after commit")
    expect(document.status).toBe("READY")
    expect(document.markdownContent).toContain("![image]")
    expect(mocks.cleanup).not.toHaveBeenCalled()
  })

  it("rejects an old index version before making external calls", async () => {
    document.status = "READY"
    await expect(
      indexKnowledgeDocument({ ...input, contentRevision: 1 })
    ).rejects.toMatchObject({ code: "CONTENT_REVISION_CONFLICT" })
    expect(mocks.embed).not.toHaveBeenCalled()
  })
})

const uploadInput = {
  userId: input.userId,
  knowledgeBaseId: "base",
  folderId: null,
  filename: "source.md",
  mimeType: "text/markdown",
  buffer: source,
}

describe("upload processes the document in the request", () => {
  it("waits for indexing, reuses the upload bytes and never queues a parse job", async () => {
    const indexed = Promise.withResolvers<void>()
    mocks.es.mockReturnValue(indexed.promise)
    let settled = false
    const pending = createKnowledgeDocumentUpload(uploadInput).then(
      (result) => {
        settled = true
        return result
      }
    )
    await vi.waitFor(() => expect(mocks.es).toHaveBeenCalled())
    expect(settled).toBe(false)
    expect(document.chunkStatus).toBe("RUNNING")
    indexed.resolve()
    expect(await pending).toMatchObject({
      status: "READY",
      chunkStatus: "READY",
      contentRevision: 1,
    })
    expect(mocks.put.mock.calls[0][1]).toBe(source)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.jobCreate).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("retains the source and exposes the document ID and parse failure", async () => {
    mocks.parser.mockReturnValue({
      version: "test",
      parse: async () => {
        throw new KnowledgeParseError(
          "PARSE_FAILED",
          "Parser rejected the file"
        )
      },
    })
    await expect(
      createKnowledgeDocumentUpload(uploadInput)
    ).rejects.toMatchObject({
      status: 400,
      message: "Parser rejected the file",
      details: { documentId: expect.any(String), phase: "parse" },
    })
    expect(document.status).toBe("FAILED")
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it.each(["embedding", "elasticsearch", "postgres"])(
    "retains parsed content after %s failure",
    async (stage) => {
      const error = new Error("Provider private failure")
      if (stage === "embedding") mocks.embed.mockRejectedValue(error)
      if (stage === "elasticsearch") mocks.es.mockRejectedValue(error)
      if (stage === "postgres") mocks.replace.mockRejectedValue(error)
      const result = await createKnowledgeDocumentUpload(uploadInput).catch(
        (error: unknown) => error
      )
      expect(result).toMatchObject({
        code: "KNOWLEDGE_DOCUMENT_PROCESSING_FAILED",
        status: 502,
        cause: error,
        details: { documentId: document.id, phase: "index" },
      })
      expect((result as Error).message).not.toContain("private")
      expect(document).toMatchObject({
        status: "READY",
        chunkStatus: "FAILED",
        contentRevision: 1,
      })
      expect(document.markdownContent).toContain("A real paragraph.")
      expect(mocks.remove).not.toHaveBeenCalled()
    }
  )

  it.each(["ownership", "folder"])(
    "rejects failed %s checks before uploading",
    async (boundary) => {
      const denied = new KnowledgeError(
        "KNOWLEDGE_BASE_NOT_FOUND",
        "Not found",
        404
      )
      if (boundary === "ownership") mocks.ownedBase.mockRejectedValue(denied)
      else mocks.ownedFolder.mockRejectedValue(denied)
      await expect(
        createKnowledgeDocumentUpload({ ...uploadInput, folderId: "folder" })
      ).rejects.toBe(denied)
      expect(mocks.put).not.toHaveBeenCalled()
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )

  it.each([
    { filename: "source.exe", buffer: source },
    { filename: "source.pdf", mimeType: "application/pdf", buffer: source },
    { buffer: Buffer.alloc(0) },
    { buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
  ])("rejects an invalid file before storage", async (invalid) => {
    await expect(
      createKnowledgeDocumentUpload({ ...uploadInput, ...invalid })
    ).rejects.toBeInstanceOf(KnowledgeParseError)
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it.each(["QUEUED", "READY"])(
    "does not fail a subsequent %s operation while handling the upload error",
    async (status) => {
      mocks.embed.mockImplementation(async () => {
        document.status = status
        document.contentRevision = status === "QUEUED" ? 1 : 2
        document.chunkStatus = "PENDING"
        throw new Error("Upload operation superseded")
      })
      await expect(
        createKnowledgeDocumentUpload(uploadInput)
      ).rejects.toMatchObject({
        details: { phase: "index" },
      })
      expect(document.status).toBe(status)
      expect(document.chunkStatus).toBe("PENDING")
    }
  )

  it("reports source upload errors without creating a document", async () => {
    const error = new Error("OSS unavailable")
    mocks.put.mockRejectedValue(error)
    await expect(createKnowledgeDocumentUpload(uploadInput)).rejects.toBe(error)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.jobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CLEANUP",
        payload: expect.objectContaining({
          storageKey: mocks.put.mock.calls[0][0],
        }),
      }),
    })
    expect(
      mocks.jobCreate.mock.calls[0][0].data.availableAt.getTime()
    ).toBeGreaterThan(Date.now())
  })

  it.each([false, true])(
    "cleans an uncommitted source (cleanup failure: %s)",
    async (cleanupFails) => {
      const error = new Error("Database insert failed")
      mocks.create.mockRejectedValue(error)
      if (cleanupFails)
        mocks.remove.mockRejectedValue(new Error("OSS delete failed"))
      await expect(createKnowledgeDocumentUpload(uploadInput)).rejects.toBe(
        error
      )
      expect(mocks.remove).toHaveBeenCalledWith(mocks.put.mock.calls[0][0])
      if (cleanupFails)
        expect(mocks.jobCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              type: "CLEANUP",
              payload: expect.objectContaining({
                storageKey: mocks.put.mock.calls[0][0],
              }),
            }),
          })
        )
      else expect(mocks.jobCreate).not.toHaveBeenCalled()
      expect(mocks.embed).not.toHaveBeenCalled()
    }
  )

  it("compensates an abort after OSS upload before the document is created", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Upload cancelled", "AbortError")
    mocks.put.mockImplementation(async () => controller.abort(reason))
    await expect(
      createKnowledgeDocumentUpload({
        ...uploadInput,
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalled()
  })

  it("marks an early cancellation after persistence failed and keeps the source", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Upload cancelled", "AbortError")
    let transactionCount = 0
    const transaction = mocks.transaction.getMockImplementation()!
    mocks.transaction.mockImplementation(async (...args) => {
      const result = await transaction(...args)
      if (++transactionCount === 2) controller.abort(reason)
      return result
    })
    await expect(
      createKnowledgeDocumentUpload({
        ...uploadInput,
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(document.status).toBe("FAILED")
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("marks indexing failed when cancellation arrives between parse and index", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Upload cancelled", "AbortError")
    let transactionCount = 0
    const transaction = mocks.transaction.getMockImplementation()!
    mocks.transaction.mockImplementation(async (...args) => {
      const result = await transaction(...args)
      if (++transactionCount === 4) controller.abort(reason)
      return result
    })
    await expect(
      createKnowledgeDocumentUpload({
        ...uploadInput,
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(document).toMatchObject({
      status: "READY",
      chunkStatus: "FAILED",
      contentRevision: 1,
    })
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})

describe("direct reparse", () => {
  const revision = { expectedContentRevision: 4 }
  const reparse = (signal?: AbortSignal) =>
    reparseKnowledgeDocument(input.userId, input.documentId, revision, signal)
  beforeEach(() => {
    Object.assign(document, {
      status: "READY",
      contentRevision: 4,
      markdownContent: "Old saved body",
      chunkStatus: "READY",
      chunkedContentRevision: 4,
      parseMetadata: {
        assetNames: ["00000000-0000-0000-0000-000000000000-0001.png"],
      },
    })
  })

  it("waits for both indexes and increments the confirmed revision once without creating a job", async () => {
    const index = Promise.withResolvers<void>()
    mocks.es.mockReturnValue(index.promise)
    let settled = false
    const pending = reparse().then((data) => {
      settled = true
      return data
    })
    await vi.waitFor(() => expect(mocks.es).toHaveBeenCalled())
    expect(settled).toBe(false)
    expect(document).toMatchObject({
      contentRevision: 5,
      chunkStatus: "RUNNING",
    })
    expect(mocks.get).toHaveBeenCalledWith("original")
    index.resolve()
    expect(await pending).toMatchObject({
      status: "READY",
      contentRevision: 5,
      chunkStatus: "READY",
      chunkedContentRevision: 5,
    })
    expect(mocks.jobCreate).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.registerCleanup).toHaveBeenCalledWith(
      db,
      [
        expect.objectContaining({
          storageKey: null,
          parseMetadata: {
            assetNames: ["00000000-0000-0000-0000-000000000000-0001.png"],
          },
        }),
      ],
      "reparse"
    )
  })

  it("cleans old images only after the new body and both indexes have been committed", async () => {
    mocks.runCleanup.mockImplementation(async () => {
      expect(document).toMatchObject({
        contentRevision: 5,
        status: "READY",
        chunkStatus: "READY",
      })
      expect(mocks.replace).toHaveBeenCalled()
      return { completed: 1, failed: 0, pending: 0 }
    })
    await reparse()
    expect(mocks.runCleanup).toHaveBeenCalledWith(["document"])
  })

  it("reports cleanup failure without discarding successfully rebuilt content or indexes", async () => {
    mocks.runCleanup.mockResolvedValue({ completed: 0, failed: 1, pending: 0 })
    await expect(reparse()).rejects.toMatchObject({
      code: "KNOWLEDGE_CLEANUP_FAILED",
      status: 502,
      details: { documentId: "document", phase: "cleanup", cleanupPending: 1 },
    })
    expect(document).toMatchObject({
      contentRevision: 5,
      status: "READY",
      chunkStatus: "READY",
    })
  })

  it("retains a cleanup key when an image upload fails with an uncertain provider result", async () => {
    mocks.parser.mockReturnValue(assetParser)
    mocks.put.mockRejectedValueOnce(new Error("Upload response lost"))
    await expect(reparse()).rejects.toMatchObject({
      details: { phase: "parse" },
    })
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            payload: expect.objectContaining({
              storageKey: mocks.put.mock.calls[0][0],
            }),
          }),
        ],
      })
    )
    expect(
      mocks.cleanup.mock.calls[0][0].data[0].availableAt.getTime()
    ).toBeGreaterThan(Date.now())
    expect(mocks.runCleanup).toHaveBeenCalledWith(["document"])
    expect(document).toMatchObject({
      status: "FAILED",
      contentRevision: 4,
      markdownContent: "Old saved body",
    })
  })

  it("rejects an old confirmation without touching the current body or jobs", async () => {
    await expect(
      reparseKnowledgeDocument(input.userId, input.documentId, {
        expectedContentRevision: 3,
      })
    ).rejects.toMatchObject({ status: 409, code: "CONTENT_REVISION_CONFLICT" })
    expect(document).toMatchObject({
      contentRevision: 4,
      markdownContent: "Old saved body",
      status: "READY",
    })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it("checks the version again in the atomic start update after a concurrent revision change", async () => {
    const stale = structuredClone(document)
    mocks.find.mockImplementationOnce(async () => {
      document.contentRevision = 5
      document.markdownContent = "Newer saved body"
      return stale
    })
    await expect(reparse()).rejects.toMatchObject({ status: 409 })
    expect(document).toMatchObject({
      contentRevision: 5,
      markdownContent: "Newer saved body",
      status: "READY",
    })
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it.each(["QUEUED", "PARSING", "indexing"])(
    "rejects an active %s operation without changing it",
    async (state) => {
      if (state === "indexing") document.chunkStatus = "RUNNING"
      else document.status = state
      const before = structuredClone(document)
      await expect(reparse()).rejects.toMatchObject({
        code: "KNOWLEDGE_DOCUMENT_PROCESSING",
        status: 409,
      })
      expect(document).toEqual(before)
    }
  )

  it("rejects duplicate requests while the first is parsing", async () => {
    const read = Promise.withResolvers<Buffer>()
    mocks.get.mockReturnValue(read.promise)
    const first = reparse()
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled())
    await expect(reparse()).rejects.toMatchObject({ status: 409 })
    expect(document.status).toBe("PARSING")
    read.resolve(source)
    await first
    expect(document.contentRevision).toBe(5)
  })

  it("checks ownership and refuses missing originals before changing status", async () => {
    await expect(
      reparseKnowledgeDocument("other", input.documentId, revision)
    ).rejects.toMatchObject({ status: 404 })
    document.storageKey = ""
    await expect(reparse()).rejects.toMatchObject({
      code: "KNOWLEDGE_DOCUMENT_NO_ORIGINAL",
      status: 409,
    })
    expect(document.status).toBe("READY")
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it("retains the old body and images when parsing fails, then allows an explicit retry", async () => {
    mocks.get.mockRejectedValueOnce(new Error("OSS unavailable"))
    await expect(reparse()).rejects.toMatchObject({
      status: 502,
      details: { documentId: "document", phase: "parse" },
    })
    expect(document).toMatchObject({
      status: "FAILED",
      contentRevision: 4,
      markdownContent: "Old saved body",
      chunkedContentRevision: 4,
    })
    expect(mocks.registerCleanup).not.toHaveBeenCalled()
    expect(await reparse()).toMatchObject({
      status: "READY",
      contentRevision: 5,
      chunkStatus: "READY",
    })
  })

  it.each(["embedding", "es", "postgres"])(
    "retains the new body with a failed index after %s failure",
    async (stage) => {
      const error = new Error("Index provider unavailable")
      if (stage === "embedding") mocks.embed.mockRejectedValue(error)
      if (stage === "es") mocks.es.mockRejectedValue(error)
      if (stage === "postgres") mocks.replace.mockRejectedValue(error)
      await expect(reparse()).rejects.toMatchObject({
        status: 502,
        cause: error,
        details: { phase: "index" },
      })
      expect(document).toMatchObject({
        status: "READY",
        contentRevision: 5,
        chunkStatus: "FAILED",
      })
      expect(document.markdownContent).toContain("A real paragraph.")
      expect(mocks.remove).not.toHaveBeenCalled()
    }
  )

  it("preserves an already queued operation when this request is pre-aborted", async () => {
    document.status = "QUEUED"
    const signal = AbortSignal.abort()
    await expect(reparse(signal)).rejects.toBe(signal.reason)
    expect(document.status).toBe("QUEUED")
  })

  it("records parse cancellation and keeps the old body", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Client disconnected", "AbortError")
    mocks.get.mockImplementation(async () => {
      controller.abort(reason)
      return source
    })
    await expect(reparse(controller.signal)).rejects.toBe(reason)
    expect(document).toMatchObject({
      status: "FAILED",
      contentRevision: 4,
      markdownContent: "Old saved body",
    })
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("records cancellation between parse and indexing at the new revision", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Client disconnected", "AbortError")
    const transaction = mocks.transaction.getMockImplementation()!
    let transactions = 0
    mocks.transaction.mockImplementation(async (...args) => {
      const result = await transaction(...args)
      if (++transactions === 2) controller.abort(reason)
      return result
    })
    await expect(reparse(controller.signal)).rejects.toBe(reason)
    expect(document).toMatchObject({
      status: "READY",
      contentRevision: 5,
      chunkStatus: "FAILED",
    })
    expect(mocks.embed).not.toHaveBeenCalled()
  })
})
