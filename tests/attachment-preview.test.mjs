import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getAttachmentPreviewKind,
  getAttachmentPreviewUrl,
  MAX_TEXT_PREVIEW_LENGTH,
  readAttachmentDocument,
  readAttachmentText,
} from "../lib/chat/attachment-preview.ts"

test("classifies the currently accepted attachment formats", () => {
  assert.equal(getAttachmentPreviewKind({ mediaType: "image/png" }), "image")
  for (const mediaType of [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json; charset=utf-8",
  ]) {
    assert.equal(getAttachmentPreviewKind({ mediaType }), "text")
  }
  assert.equal(
    getAttachmentPreviewKind({ mediaType: "", filename: "README.MD" }),
    "text"
  )
  assert.equal(
    getAttachmentPreviewKind({
      mediaType: "application/octet-stream",
      filename: "data.json",
    }),
    "text"
  )
  assert.equal(
    getAttachmentPreviewKind({ mediaType: "application/pdf" }),
    "document"
  )
  assert.equal(
    getAttachmentPreviewKind({ mediaType: "", filename: "report.DOCX" }),
    "document"
  )
  assert.equal(
    getAttachmentPreviewKind({
      mediaType: "application/msword",
      filename: "old.doc",
    }),
    "unsupported"
  )
})

test("accepts local attachments and rejects unsafe URLs", () => {
  for (const url of [
    "/api/files/123",
    "https://example.com/photo.png",
    "blob:http://localhost:3000/123",
    "data:text/plain;charset=utf-8,hello",
    "data:application/octet-stream;base64,aGk=",
    "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,aGk=",
  ]) {
    assert.equal(getAttachmentPreviewUrl(url), url)
  }
  for (const url of [
    "javascript:alert(1)",
    "file:///secret.txt",
    "//example.com/file",
    "/\\example.com/file",
    "https://user:password@example.com/file",
    "data:application/javascript,alert(1)",
    "",
    "not-a-url",
  ]) {
    assert.equal(getAttachmentPreviewUrl(url), null)
  }
})

test("reads Unicode Data URLs without executing HTML", async () => {
  const content = "你好，附件！\n<script>alert(1)</script>"
  const result = await readAttachmentText(
    `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`,
    new AbortController().signal
  )
  assert.deepEqual(result, { text: content, truncated: false })
})

test("reads pending Blob URLs", async () => {
  const url = URL.createObjectURL(
    new Blob(["# Markdown\n待发送文件"], { type: "text/markdown" })
  )
  try {
    assert.deepEqual(
      await readAttachmentText(url, new AbortController().signal),
      { text: "# Markdown\n待发送文件", truncated: false }
    )
  } finally {
    URL.revokeObjectURL(url)
  }
})

test("handles empty files and clips long text", async () => {
  assert.deepEqual(
    await readAttachmentText("data:text/plain,", new AbortController().signal),
    { text: "", truncated: false }
  )
  const result = await readAttachmentText(
    `data:text/plain,${"a".repeat(MAX_TEXT_PREVIEW_LENGTH + 10)}`,
    new AbortController().signal
  )
  assert.equal(result.text.length, MAX_TEXT_PREVIEW_LENGTH)
  assert.equal(result.truncated, true)
})

test("rejects oversized files and cancelled requests", async () => {
  await assert.rejects(
    readAttachmentText(
      `data:text/plain,${"a".repeat(2 * 1024 * 1024 + 1)}`,
      new AbortController().signal
    ),
    /2 MB/
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    readAttachmentText("data:text/plain,hello", controller.signal),
    { name: "AbortError" }
  )
})

test("handles failed reads and enforces declared file size", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 404 })
  )
  await assert.rejects(
    readAttachmentText(
      "https://example.com/missing",
      new AbortController().signal
    ),
    /附件读取失败/
  )
  globalThis.fetch.mock.mockImplementation(
    async () =>
      new Response("large", {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      })
  )
  await assert.rejects(
    readAttachmentText(
      "https://example.com/large",
      new AbortController().signal
    ),
    /2 MB/
  )
})

test("decodes Unicode split across stream chunks", async (context) => {
  const bytes = new TextEncoder().encode("你好")
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 1))
            controller.enqueue(bytes.slice(1, 4))
            controller.enqueue(bytes.slice(4))
            controller.close()
          },
        })
      )
  )
  assert.deepEqual(
    await readAttachmentText(
      "https://example.com/text",
      new AbortController().signal
    ),
    { text: "你好", truncated: false }
  )
})

test("sends bounded document bytes to authenticated preview endpoint", async () => {
  const bytes = Buffer.from([0, 128, 255, 65])
  const document = {
    url: "data:application/pdf;base64," + bytes.toString("base64"),
    mediaType: "application/pdf",
    filename: "test.pdf",
  }
  let called = false
  const request = async (url, init) => {
    called = true
    assert.ok(url.endsWith("/api/chat/attachments/preview"))
    assert.equal(init.credentials, "include")
    assert.equal(init.method, "POST")
    const body = JSON.parse(init.body)
    assert.equal(body.filename, "test.pdf")
    assert.equal(body.mediaType, "application/pdf")
    assert.equal(
      body.url,
      "data:application/octet-stream;base64," + bytes.toString("base64")
    )
    return Response.json({ text: "文档内容", truncated: false })
  }
  assert.deepEqual(
    await readAttachmentDocument(
      document,
      new AbortController().signal,
      request
    ),
    { text: "文档内容", truncated: false }
  )
  assert.equal(called, true)
})

test("document preview forwards parsing errors and handles missing login", async () => {
  const file = {
    url: "data:application/pdf;base64,aGk=",
    mediaType: "application/pdf",
  }
  const signal = new AbortController().signal
  await assert.rejects(
    readAttachmentDocument(
      file,
      signal,
      async () => new Response("PDF 未提取到文字，请先 OCR", { status: 400 })
    ),
    /OCR/
  )
  await assert.rejects(
    readAttachmentDocument(
      file,
      signal,
      async () => new Response("未认证", { status: 401 })
    ),
    /登录/
  )
  await assert.rejects(
    readAttachmentDocument(file, signal, async () =>
      Response.json({ text: null })
    ),
    /返回内容无效/
  )
})

test("rejects oversized document reads before requesting parsing", async () => {
  let called = false
  const request = async () => {
    called = true
    return Response.json({ text: "" })
  }
  await assert.rejects(
    readAttachmentDocument(
      {
        url:
          "data:application/pdf;base64," +
          Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
        mediaType: "application/pdf",
      },
      new AbortController().signal,
      request
    ),
    /2 MB/
  )
  assert.equal(called, false)
})
