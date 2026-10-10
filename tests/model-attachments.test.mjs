import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import mammoth from "mammoth"
import {
  createAttachmentPreparer,
  decodeAttachmentDataUrl,
  extractDocumentText,
  getDocumentKind,
  MAX_ATTACHMENT_BYTES,
  MAX_DOCUMENT_TEXT_LENGTH,
} from "../lib/chat/model-attachments.ts"

// 使用 Mammoth 自己依赖的 ZIP 库构造内存测试文件，不读写用户文件。
const JSZip = createRequire(import.meta.resolve("mammoth"))("jszip")
const docxMediaType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

async function makeDocx(text = "你好，DOCX 附件", configure = () => {}) {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="' +
      docxMediaType +
      '.main+xml"/></Types>'
  )
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>"
  )
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>" +
      escaped +
      "</w:t></w:r></w:p></w:body></w:document>"
  )
  configure(zip)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

function makePdf(text = "Hello PDF attachment", pages = 1) {
  const content =
    "BT /F1 12 Tf 20 250 Td (" + text.replace(/[\\()]/g, "\\$&") + ") Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" +
      Array.from({ length: pages }, (_, i) => i + 5 + " 0 R").join(" ") +
      "] /Count " +
      pages +
      " >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " +
      Buffer.byteLength(content) +
      " >>\nstream\n" +
      content +
      "\nendstream",
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>"
    ),
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((value, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += index + 1 + " 0 obj\n" + value + "\nendobj\n"
  })
  const xref = Buffer.byteLength(pdf)
  pdf += "xref\n0 " + offsets.length + "\n0000000000 65535 f \n"
  for (const offset of offsets.slice(1))
    pdf += String(offset).padStart(10, "0") + " 00000 n \n"
  pdf +=
    "trailer\n<< /Size " +
    offsets.length +
    " /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF"
  return Buffer.from(pdf)
}

function filePart(buffer, filename, mediaType) {
  return {
    type: "file",
    filename,
    mediaType,
    url: "data:" + mediaType + ";base64," + buffer.toString("base64"),
  }
}

test("recognizes PDF/DOCX by MIME or extension, but not legacy DOC", () => {
  assert.equal(getDocumentKind({ mediaType: "application/pdf" }), "pdf")
  assert.equal(
    getDocumentKind({ mediaType: "", filename: "REPORT.PDF" }),
    "pdf"
  )
  assert.equal(getDocumentKind({ mediaType: docxMediaType }), "docx")
  assert.equal(
    getDocumentKind({
      mediaType: "application/octet-stream",
      filename: "REPORT.DOCX",
    }),
    "docx"
  )
  assert.equal(
    getDocumentKind({ mediaType: "application/msword", filename: "old.doc" }),
    null
  )
})

test("decodes bytes and rejects remote URLs, invalid base64 and oversized input", () => {
  assert.equal(
    decodeAttachmentDataUrl(
      "data:text/plain," + encodeURIComponent("你好")
    ).toString(),
    "你好"
  )
  const buffer = Buffer.from([0, 128, 255])
  assert.deepEqual(
    decodeAttachmentDataUrl(
      filePart(buffer, "file.pdf", "application/pdf").url
    ),
    buffer
  )
  for (const url of [
    "https://example.com/file.pdf",
    "data:application/pdf",
    "data:application/pdf;base64,@@@",
  ])
    assert.throws(() => decodeAttachmentDataUrl(url), { status: 400 })
  assert.throws(
    () =>
      decodeAttachmentDataUrl(
        filePart(
          Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
          "big.pdf",
          "application/pdf"
        ).url
      ),
    { status: 413 }
  )
})

test("extracts real PDF text and rejects empty/scanned and excessive-page PDFs", async () => {
  const info = { mediaType: "application/pdf", filename: "report.pdf" }
  assert.equal(
    await extractDocumentText(makePdf(), info),
    "Hello PDF attachment"
  )
  await assert.rejects(extractDocumentText(makePdf(""), info), /OCR/)
  await assert.rejects(extractDocumentText(makePdf("hello", 51), info), /50 页/)
  await assert.rejects(
    extractDocumentText(Buffer.from("fake PDF"), info),
    /有效的 PDF/
  )
})

test("extracts Chinese DOCX text as plain text, without executing HTML", async () => {
  const text = '你好，DOCX！<script>alert("hello")</script>'
  assert.equal(
    await extractDocumentText(await makeDocx(text), {
      mediaType: docxMediaType,
      filename: "report.docx",
    }),
    text
  )
})

test("rejects corrupt, renamed, empty and oversized documents", async () => {
  const info = { mediaType: docxMediaType, filename: "report.docx" }
  await assert.rejects(
    extractDocumentText(Buffer.from("not a ZIP"), info),
    /解析失败/
  )
  const arbitraryZip = new JSZip().file("hello.txt", "hello")
  await assert.rejects(
    extractDocumentText(
      await arbitraryZip.generateAsync({ type: "nodebuffer" }),
      info
    ),
    /有效的 DOCX/
  )
  await assert.rejects(
    extractDocumentText(await makeDocx(""), info),
    /未提取到文字/
  )
  await assert.rejects(
    extractDocumentText(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), info),
    { status: 413 }
  )
  await assert.rejects(
    extractDocumentText(
      await makeDocx("a".repeat(MAX_DOCUMENT_TEXT_LENGTH + 1)),
      info
    ),
    /100,000/
  )
})

test("rejects DOCX decompression bombs before handing bytes to Mammoth", async (context) => {
  const spy = context.mock.method(mammoth, "extractRawText")
  const buffer = await makeDocx("hello", (zip) =>
    zip.file("word/oversized.xml", "a".repeat(5 * 1024 * 1024 + 1))
  )
  assert.ok(buffer.length < MAX_ATTACHMENT_BYTES)
  await assert.rejects(
    extractDocumentText(buffer, {
      mediaType: docxMediaType,
      filename: "bomb.docx",
    }),
    /解压后过大/
  )
  assert.equal(spy.mock.callCount(), 0)
})

test("passes images through and turns documents into model text without changing stored messages", async () => {
  const image = {
    type: "file",
    mediaType: "image/png",
    url: "data:image/png;base64,aGk=",
  }
  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [
        { type: "text", text: "总结附件" },
        image,
        filePart(makePdf(), "test.pdf", "application/pdf"),
        filePart(await makeDocx(), "test.docx", docxMediaType),
      ],
    },
  ]
  const prepared = await createAttachmentPreparer()(messages)
  assert.equal(prepared[0].parts[1], image)
  assert.match(prepared[0].parts[2].text, /test\.pdf.*内容开始.*Hello PDF/s)
  assert.match(prepared[0].parts[3].text, /你好，DOCX/)
  assert.equal(messages[0].parts[2].type, "file")
  assert.equal(messages[0].parts[3].type, "file")
})

test("caches repeated validation/history extraction only within one request", async (context) => {
  const spy = context.mock.method(mammoth, "extractRawText")
  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [filePart(await makeDocx(), "test.docx", docxMediaType)],
    },
  ]
  const prepare = createAttachmentPreparer()
  await prepare(messages)
  await prepare(messages)
  assert.equal(spy.mock.callCount(), 1)
  await createAttachmentPreparer()(messages)
  assert.equal(spy.mock.callCount(), 2)
})

test("keeps text attachments working and rejects unsupported or too many files", async () => {
  const prepare = createAttachmentPreparer()
  const text = filePart(
    Buffer.from("# README\n测试"),
    "readme.md",
    "text/markdown"
  )
  const message = { id: "user-1", role: "user", parts: [text] }
  assert.match((await prepare([message]))[0].parts[0].text, /# README\n测试/)
  await assert.rejects(
    prepare([{ ...message, parts: [text, text, text, text] }]),
    /3 个附件/
  )
  await assert.rejects(
    prepare([
      {
        ...message,
        parts: [filePart(Buffer.from("doc"), "old.doc", "application/msword")],
      },
    ]),
    { status: 400 }
  )
})
