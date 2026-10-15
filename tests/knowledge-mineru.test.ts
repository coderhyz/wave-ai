import JSZip from "jszip"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMineruParser } from "@/lib/knowledge/parsers/mineru-to-markdown"
import { parseWithMineru } from "@/lib/knowledge/parsers/mineru-client"

const fetchMock = vi.fn<typeof fetch>()
let archiveBytes: Uint8Array<ArrayBuffer>

beforeEach(async () => {
  vi.stubEnv("MINERU_API_TOKEN", "test-token")
  vi.stubEnv("MINERU_POLL_INTERVAL_MS", "100000")
  vi.stubGlobal("fetch", fetchMock)
  const archive = new JSZip()
  archive.file(
    "document/full.md",
    "# Title\n\n![first](images/a.png)\n\n![second](images/b.png)"
  )
  archive.file("document/images/a.png", Buffer.from("first image"))
  archive.file("document/images/b.png", Buffer.from("second image"))
  archiveBytes = new Uint8Array(
    await archive.generateAsync({ type: "arraybuffer" })
  )
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({
        code: 0,
        data: {
          batch_id: "batch",
          file_urls: ["https://uploads.example/source"],
        },
      })
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      Response.json({
        code: 0,
        data: {
          extract_result: [
            {
              state: "done",
              full_zip_url: "https://results.example/archive.zip",
            },
          ],
        },
      })
    )
    .mockImplementation(async () => new Response(archiveBytes))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("MinerU parsing with cancellation", () => {
  it.each(["pdf", "docx"] as const)(
    "parses %s and forwards one signal through all HTTP requests and image transfers",
    async (kind) => {
      const signal = new AbortController().signal
      const uploadAsset = vi.fn(
        async () => "/api/knowledge-documents/document/assets/image.png"
      )
      const result = await createMineruParser(kind).parse(
        Buffer.from("source"),
        {
          filename: `source.${kind}`,
          mimeType:
            kind === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          signal,
          uploadAsset,
        }
      )
      expect(fetchMock).toHaveBeenCalledTimes(4)
      for (const [, options] of fetchMock.mock.calls)
        expect(options?.signal).toBe(fetchMock.mock.calls[0][1]?.signal)
      expect(uploadAsset).toHaveBeenCalledTimes(2)
      expect(result.markdown).toContain(
        "/api/knowledge-documents/document/assets/image.png"
      )
      expect(result.sections[0].locator.headingPath).toEqual(["Title"])
      expect(result.metadata).toMatchObject({
        format: kind,
        batchId: "batch",
        provider: "mineru",
      })
    }
  )

  it("does not send a request if already cancelled", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled")
    controller.abort(reason)
    await expect(
      parseWithMineru(Buffer.from("source"), "source.pdf", controller.signal)
    ).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("cancels the polling sleep immediately without making another status request", async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: {
            batch_id: "batch",
            file_urls: ["https://uploads.example/source"],
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(
        Response.json({
          code: 0,
          data: { extract_result: [{ state: "running" }] },
        })
      )
    const controller = new AbortController()
    const reason = new Error("stop waiting")
    const pending = parseWithMineru(
      Buffer.from("source"),
      "source.pdf",
      controller.signal
    )
    const rejected = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    controller.abort(reason)
    await rejected
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([false, true])(
    "bounds the HTTP call even with a caller signal: %s",
    async (withSignal) => {
      vi.stubEnv("MINERU_TIMEOUT_MS", "30")
      fetchMock.mockReset().mockImplementation(async (_url, options) => {
        const signal = options?.signal
        if (!signal) throw new Error("missing signal")
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        })
      })
      await expect(
        parseWithMineru(
          Buffer.from("source"),
          "source.pdf",
          withSignal ? new AbortController().signal : undefined
        )
      ).rejects.toMatchObject({ name: "TimeoutError" })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("cancels result download and propagates the caller's reason", async () => {
    fetchMock.mockImplementation(async (_url, options) => {
      const signal = options?.signal
      if (!signal) throw new Error("missing signal")
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      })
    })
    const controller = new AbortController()
    const reason = new Error("cancel download")
    const pending = parseWithMineru(
      Buffer.from("source"),
      "source.pdf",
      controller.signal
    )
    const rejected = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    controller.abort(reason)
    await rejected
  })

  it("stops transferring more images after cancellation", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel images")
    const uploadAsset = vi.fn(async () => {
      controller.abort(reason)
      return "/api/image.png"
    })
    await expect(
      createMineruParser("pdf").parse(Buffer.from("source"), {
        filename: "source.pdf",
        mimeType: "application/pdf",
        signal: controller.signal,
        uploadAsset,
      })
    ).rejects.toBe(reason)
    expect(uploadAsset).toHaveBeenCalledTimes(1)
  })

  it("keeps explicit provider failures visible", async () => {
    fetchMock
      .mockReset()
      .mockResolvedValue(
        Response.json({ code: 1, msg: "provider unavailable" }, { status: 503 })
      )
    await expect(
      parseWithMineru(Buffer.from("source"), "source.pdf")
    ).rejects.toMatchObject({ code: "PARSE_FAILED", retryable: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects a done response without its archive URL", async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: {
            batch_id: "batch",
            file_urls: ["https://uploads.example/source"],
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: { extract_result: [{ state: "done" }] },
        })
      )
    await expect(
      parseWithMineru(Buffer.from("source"), "source.pdf")
    ).rejects.toMatchObject({ code: "PARSE_FAILED" })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
