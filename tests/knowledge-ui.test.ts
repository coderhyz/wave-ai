/** P2-a 回归：模拟网络但执行真实 Query 配置及 Markdown 渲染，不连接 OSS/MinerU。 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { withNuqsTestingAdapter } from "nuqs/adapters/testing"
import { KnowledgeWorkspace } from "@/components/knowledge/knowledge-workspace"
import {
  QueryClient,
  QueryObserver,
  MutationObserver,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  useCreateKnowledgeBase,
  useCreateKnowledgeFolder,
  useKnowledgeDocument,
  useKnowledgeTree,
  useUploadKnowledgeDocument,
  useSaveKnowledgeDocumentContent,
  KnowledgeRequestError,
  useReparseKnowledgeDocument,
  useDeleteKnowledgeDocument,
  downloadKnowledgeDocumentOriginal,
  useKnowledgeFilePreview,
  useRenameKnowledgeDocument,
  useRenameKnowledgeFolder,
  useDeleteKnowledgeFolder,
  useDeleteKnowledgeBase,
} from "@/hooks/use-knowledge"
import {
  FilePreview,
  OriginalMarkdown,
} from "@/components/knowledge/file-preview"
import {
  decodeOriginalText,
  getFilePreviewKind,
} from "@/lib/knowledge/file-preview"
import {
  DocumentPreview,
  KnowledgeMarkdown,
  reconcileSavedDraft,
} from "@/components/knowledge/document-preview"

// 捕获 Hook 提交的配置，再交给真实 QueryClient/Mutation 执行，无需新增 DOM 测试依赖。
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: () => queryClient,
}))

let queryClient: QueryClient
const fetchMock = vi.fn<typeof fetch>()
const documentId = "10000000-0000-4000-8000-000000000001"
const assetName = "20000000-0000-4000-8000-000000000002-0001.png"

beforeEach(() => {
  vi.clearAllMocks()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  vi.stubGlobal("fetch", fetchMock)
  const result = new MutationObserver<unknown, unknown, unknown, unknown>(
    queryClient,
    {}
  ).getCurrentResult()
  vi.mocked(useMutation).mockReturnValue({
    ...result,
    mutateAsync: result.mutate,
  })
})

afterEach(() => {
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function queryOptions() {
  const call = vi.mocked(useQuery).mock.calls.at(-1)
  if (!call) throw new Error("Hook did not register a query")
  return call[0]
}

function mutation() {
  const call = vi.mocked(useMutation).mock.calls.at(-1)
  if (!call) throw new Error("Hook did not register a mutation")
  return queryClient.getMutationCache().build(queryClient, call[0])
}

describe("original file preview", () => {
  const file = {
    fileName: "笔记.md",
    mimeType: "text/markdown",
    url: "https://oss.example.test/original?signature=temporary",
    expiresAt: Date.now() + 900_000,
  }

  it.each([
    ["REPORT.PDF", null, "pdf"],
    ["report", "application/pdf", "pdf"],
    ["报告.docx", null, "docx"],
    ["note.md", "text/plain", "markdown"],
    ["note.txt", "text/plain; charset=utf-8", "text"],
    ["photo.png", null, "image"],
    ["photo", "image/jpeg", "image"],
    ["drawing.svg", "image/svg+xml", "unsupported"],
    ["data.xlsx", null, "unsupported"],
  ])("selects a preview for %s", (name, mime, kind) => {
    expect(getFilePreviewKind(name, mime)).toBe(kind)
  })

  it("decodes original UTF-8, UTF-16 and GB18030 without normalizing whitespace", () => {
    const original = "# 标题\r\n  缩进\t文本\n\n"
    expect(decodeOriginalText(new TextEncoder().encode(original).buffer)).toBe(
      original
    )
    expect(
      decodeOriginalText(
        Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x0a, 0]).buffer
      )
    ).toBe("中\n")
    expect(
      decodeOriginalText(
        Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d, 0, 0x0a]).buffer
      )
    ).toBe("中\n")
    expect(
      decodeOriginalText(Uint8Array.from([0xd6, 0xd0, 0x20, 0x0a]).buffer)
    ).toBe("中 \n")
  })

  it.each(["md", "txt"])(
    "loads %s bytes once, without passing app credentials to OSS",
    async (extension) => {
      const metadata = { ...file, fileName: `笔记.${extension}` }
      const text = "# 原件\r\n  空格\t保留\n"
      fetchMock
        .mockResolvedValueOnce(Response.json({ success: true, file: metadata }))
        .mockResolvedValueOnce(new Response(text))
      useKnowledgeFilePreview(documentId)
      const options = queryOptions()
      const data = await queryClient.fetchQuery(options)
      expect(data).toMatchObject({
        ...metadata,
        text,
        kind: extension === "md" ? "markdown" : "text",
      })
      expect(await queryClient.fetchQuery(options)).toEqual(data)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        `/api/knowledge-documents/${documentId}/preview`
      )
      expect(fetchMock.mock.calls[1]).toEqual([
        file.url,
        { credentials: "omit", signal: expect.any(AbortSignal) },
      ])
      expect(options.retry).toBe(false)
      expect(options.gcTime).toBe(0)
      expect(options.refetchOnWindowFocus).toBe(false)
    }
  )

  it.each(["pdf", "docx"])(
    "downloads %s once for the renderer with no MIME HEAD probe",
    async (extension) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          success: true,
          file: { ...file, fileName: `报告.${extension}`, mimeType: null },
        })
      )
      fetchMock.mockResolvedValueOnce(new Response("original bytes"))
      useKnowledgeFilePreview(documentId)
      expect(await queryClient.fetchQuery(queryOptions())).toMatchObject({
        text: null,
        url: file.url,
        fileData: expect.any(ArrayBuffer),
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][1]?.credentials).toBe("omit")
    }
  )

  it("leaves image loading to the browser", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        file: { ...file, fileName: "photo.png", mimeType: "image/png" },
      })
    )
    useKnowledgeFilePreview(documentId)
    expect(await queryClient.fetchQuery(queryOptions())).toMatchObject({
      kind: "image",
      text: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports OSS errors and signs again on an explicit retry", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ success: true, file }))
      .mockResolvedValueOnce(
        new Response("Request has expired", { status: 403 })
      )
    useKnowledgeFilePreview(documentId)
    const options = queryOptions()
    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "Request has expired"
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          file: { ...file, url: "https://oss.example.test/new-signature" },
        })
      )
      .mockResolvedValueOnce(new Response("# 重试成功"))
    expect(await queryClient.fetchQuery(options)).toMatchObject({
      text: "# 重试成功",
    })
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://oss.example.test/new-signature"
    )
  })

  it("does not download OSS content after authorization fails", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: "知识库文档不存在" } }, { status: 404 })
    )
    useKnowledgeFilePreview(documentId)
    await expect(queryClient.fetchQuery(queryOptions())).rejects.toThrow(
      "知识库文档不存在"
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("renders GFM structure and avoids active HTML or tracking images", () => {
    const html = renderToStaticMarkup(
      createElement(OriginalMarkdown, {
        content:
          "# 标题\n\n- 列表\n\n| 列 |\n| --- |\n| 内容 |\n\n```ts\nconst a = 1\n```\n\n<script>alert(1)</script>\n\n![追踪](https://tracker.test/a.png)\n\n[危险](javascript:alert%281%29)",
      })
    )
    expect(html).toContain("<h1>标题</h1>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<table>")
    expect(html).toContain('class="language-ts"')
    expect(html).not.toMatch(/<(script|img)\b/i)
    expect(html).not.toContain('href="javascript:')
  })

  it.each([
    ["text", "# 原样\n  空格\t保留", "<pre"],
    ["unsupported", null, "暂不支持此类型在线预览"],
    [
      "image",
      null,
      'src="https://oss.example.test/original?signature=temporary"',
    ],
  ])(
    "renders %s in the same preview shell with download and close controls",
    (kind, text, expected) => {
      useKnowledgeFilePreview(documentId)
      const options = queryOptions()
      queryClient.setQueryData(options.queryKey, { ...file, kind, text })
      vi.mocked(useQuery).mockReturnValue(
        new QueryObserver(queryClient, options).getCurrentResult()
      )
      const html = renderToStaticMarkup(
        createElement(FilePreview, { documentId, onClose: vi.fn() })
      )
      expect(html).toContain(expected)
      expect(html).toContain("下载原件")
      expect(html).toContain("关闭预览")
      if (kind === "text") {
        expect(html).toContain("# 原样\n  空格\t保留")
        expect(html).not.toContain("<h1>")
      }
    }
  )
})

describe("knowledge query and upload", () => {
  it.each(["QUEUED", "PARSING", "READY", "FAILED"])(
    "polls document only while %s is processing",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ success: true, document: { id: documentId, status } })
      )
      useKnowledgeDocument(documentId)
      const options = queryOptions()
      await queryClient.fetchQuery(options)
      const query = queryClient.getQueryCache().build(queryClient, options)
      if (typeof options.refetchInterval !== "function")
        throw new Error("Missing polling configuration")
      expect(options.refetchInterval(query)).toBe(
        status === "QUEUED" || status === "PARSING" ? 3000 : false
      )
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        `/api/knowledge-documents/${documentId}`
      )
      expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    }
  )

  it("polls the tree for unselected processing documents", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ documents: [{ status: "READY" }, { status: "QUEUED" }] })
    )
    useKnowledgeTree("base-id")
    const options = queryOptions()
    await queryClient.fetchQuery(options)
    const query = queryClient.getQueryCache().build(queryClient, options)
    if (typeof options.refetchInterval !== "function")
      throw new Error("Missing polling configuration")
    expect(options.refetchInterval(query)).toBe(3000)
    query.setData({ documents: [{ status: "READY" }, { status: "FAILED" }] })
    expect(options.refetchInterval(query)).toBe(false)
  })

  it("does not query when no document is selected", () => {
    useKnowledgeDocument("")
    expect(queryOptions().enabled).toBe(false)
  })

  it("shows ownership errors and stops automatic polling", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: "知识库文档不存在" } }, { status: 404 })
    )
    useKnowledgeDocument(documentId)
    const options = queryOptions()
    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "知识库文档不存在"
    )
    const query = queryClient.getQueryCache().build(queryClient, options)
    if (typeof options.refetchInterval !== "function")
      throw new Error("Missing polling configuration")
    expect(options.refetchInterval(query)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("uploads multipart to the selected folder and seeds detail cache", async () => {
    const file = new File(["# 标题"], "笔记.md", { type: "text/markdown" })
    const data = {
      success: true,
      document: {
        id: documentId,
        knowledgeBaseId: "base-id",
        status: "QUEUED",
      },
    }
    fetchMock.mockResolvedValueOnce(Response.json(data, { status: 202 }))
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    useUploadKnowledgeDocument("base-id")
    await mutation().execute({ file, folderId: "folder-id" })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("/api/knowledge-bases/base-id/documents")
    expect(init?.body).toBeInstanceOf(FormData)
    const form = init?.body as FormData
    expect(form.get("folderId")).toBe("folder-id")
    expect((form.get("file") as File).name).toBe("笔记.md")
    expect(init?.credentials).toBe("include")
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toEqual(data)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base-id"],
    })
  })

  it("does not seed a successful document when upload is rejected", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("知识库文件不能超过 20 MB", { status: 413 })
    )
    useUploadKnowledgeDocument("base-id")
    await expect(
      mutation().execute({
        file: new File(["text"], "test.txt"),
        folderId: null,
      })
    ).rejects.toThrow("知识库文件不能超过 20 MB")
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it("uses the existing create APIs and invalidates the affected lists", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, knowledgeBase: { id: "new-base" } })
    )
    useCreateKnowledgeBase()
    await mutation().execute("资料")
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "资料",
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, folder: { id: "new-folder" } })
    )
    useCreateKnowledgeFolder("new-base")
    await mutation().execute({ name: "课程", parentId: null })
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/api/knowledge-bases/new-base/folders"
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      name: "课程",
      parentId: null,
    })
  })
})

describe("knowledge content save client", () => {
  const json = { markdownContent: "# 新内容", expectedContentRevision: 4 }
  const saved = {
    success: true,
    document: {
      id: documentId,
      knowledgeBaseId: "base-id",
      markdownContent: json.markdownContent,
      contentRevision: 5,
    },
  }

  it("sends the baseline revision and updates detail cache after success", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(saved))
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    useSaveKnowledgeDocumentContent(documentId)
    await mutation().execute(json)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(
      `/api/knowledge-documents/${documentId}/content`
    )
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual(json)
    expect(cancel).toHaveBeenCalledWith({
      queryKey: ["knowledge-document", documentId],
    })
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toEqual(saved)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base-id"],
    })
  })

  it.each([409, 500])(
    "preserves cached content and exposes status %s on save failure",
    async (status) => {
      const old = {
        document: { markdownContent: "旧正文", contentRevision: 4 },
      }
      queryClient.setQueryData(["knowledge-document", documentId], old)
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: { message: "保存未成功" } }, { status })
      )
      useSaveKnowledgeDocumentContent(documentId)
      const error = await mutation()
        .execute(json)
        .catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(KnowledgeRequestError)
      expect(error).toMatchObject({ status, message: "保存未成功" })
      expect(
        queryClient.getQueryData(["knowledge-document", documentId])
      ).toEqual(old)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("cancels a late detail response instead of allowing it to overwrite the saved version", async () => {
    let resolveRead: (response: Response) => void = () => {}
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRead = resolve
        })
    )
    fetchMock.mockResolvedValueOnce(Response.json(saved))
    useKnowledgeDocument(documentId)
    const read = queryClient
      .fetchQuery(queryOptions())
      .catch((error: unknown) => error)
    useSaveKnowledgeDocumentContent(documentId)
    await mutation().execute(json)
    resolveRead(
      Response.json({
        document: { markdownContent: "迟到的旧正文", contentRevision: 4 },
      })
    )
    await read
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toEqual(saved)
  })

  it("clears only the submitted draft after success", () => {
    const draft = { ...json, baseContent: "旧正文" }
    expect(reconcileSavedDraft(draft, json, saved.document)).toBeNull()
  })

  it("keeps typing made during save and rebases it onto the returned revision", () => {
    const draft = {
      ...json,
      markdownContent: "继续输入",
      baseContent: "旧正文",
    }
    expect(reconcileSavedDraft(draft, json, saved.document)).toEqual({
      ...draft,
      baseContent: json.markdownContent,
      expectedContentRevision: 5,
    })
  })

  it("preserves undo back to the original text while a save was pending", () => {
    const draft = { ...json, markdownContent: "旧正文", baseContent: "旧正文" }
    expect(reconcileSavedDraft(draft, json, saved.document)).toEqual({
      ...draft,
      baseContent: json.markdownContent,
      expectedContentRevision: 5,
    })
  })
})

describe("knowledge operations client", () => {
  const old = {
    document: {
      id: documentId,
      knowledgeBaseId: "base-id",
      status: "READY",
      markdownContent: "已编辑的正文",
      contentRevision: 4,
    },
  }

  it("merges a renamed title without replacing the cached body or content revision", async () => {
    queryClient.setQueryData(["knowledge-document", documentId], old)
    const metadata = {
      id: documentId,
      knowledgeBaseId: "base-id",
      title: "新的文件名",
      revision: 8,
    }
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, document: metadata })
    )
    useRenameKnowledgeDocument(documentId)
    await mutation().execute({ title: metadata.title })
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH")
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      title: metadata.title,
    })
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toEqual({ document: { ...old.document, ...metadata } })
  })

  it("renames an unloaded file without inventing a cached document body", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        document: {
          id: documentId,
          knowledgeBaseId: "base-id",
          title: "新标题",
        },
      })
    )
    useRenameKnowledgeDocument(documentId)
    await mutation().execute({ title: "新标题" })
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toBeUndefined()
  })

  it("uses the existing folder rename endpoint and refreshes its tree", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        folder: { id: "folder-id", name: "新目录" },
      })
    )
    useRenameKnowledgeFolder("folder-id", "base-id")
    await mutation().execute({ name: "新目录" })
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/knowledge-folders/folder-id"
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "新目录",
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base-id"],
    })
  })

  it.each(["folder", "base"])(
    "only clears deleted file caches for a %s deletion",
    async (kind) => {
      queryClient.setQueryData(["knowledge-document", documentId], old)
      queryClient.setQueryData(["knowledge-file-preview", documentId], {
        text: "原件",
      })
      queryClient.setQueryData(["knowledge-document", "other-document"], old)
      queryClient.setQueryData(["knowledge-file-preview", "other-document"], {
        text: "其他原件",
      })
      queryClient.setQueryData(["knowledge-bases"], {
        success: true,
        items: [{ id: "base-id" }, { id: "other-base" }],
      })
      fetchMock.mockResolvedValueOnce(
        Response.json({
          success: true,
          deleted: {
            id: kind === "folder" ? "folder-id" : "base-id",
            documentIds: [documentId],
            folderIds: ["folder-id"],
          },
        })
      )
      if (kind === "folder") useDeleteKnowledgeFolder("folder-id", "base-id")
      else useDeleteKnowledgeBase("base-id")
      await mutation().execute(undefined)
      expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE")
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        kind === "folder"
          ? "/api/knowledge-folders/folder-id?recursive=true"
          : "/api/knowledge-bases/base-id"
      )
      expect(
        queryClient.getQueryData(["knowledge-document", documentId])
      ).toBeUndefined()
      expect(
        queryClient.getQueryData(["knowledge-file-preview", documentId])
      ).toBeUndefined()
      expect(
        queryClient.getQueryData(["knowledge-document", "other-document"])
      ).toEqual(old)
      expect(
        queryClient.getQueryData(["knowledge-file-preview", "other-document"])
      ).toEqual({ text: "其他原件" })
      if (kind === "base")
        expect(queryClient.getQueryData(["knowledge-bases"])).toEqual({
          success: true,
          items: [{ id: "other-base" }],
        })
    }
  )

  it.each(["folder", "base", "document"])(
    "keeps data and propagates the error after a rejected %s mutation",
    async (kind) => {
      queryClient.setQueryData(["knowledge-document", documentId], old)
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: { message: "操作失败" } }, { status: 500 })
      )
      if (kind === "folder") useDeleteKnowledgeFolder("folder-id", "base-id")
      else if (kind === "base") useDeleteKnowledgeBase("base-id")
      else useRenameKnowledgeDocument(documentId)
      await expect(
        mutation().execute(
          kind === "document" ? { title: "新名称" } : undefined
        )
      ).rejects.toThrow("操作失败")
      expect(
        queryClient.getQueryData(["knowledge-document", documentId])
      ).toEqual(old)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("posts the confirmed revision and caches QUEUED to resume polling", async () => {
    const queued = {
      success: true,
      document: { ...old.document, status: "QUEUED" },
    }
    queryClient.setQueryData(["knowledge-document", documentId], old)
    fetchMock.mockResolvedValueOnce(Response.json(queued, { status: 202 }))
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    useReparseKnowledgeDocument(documentId)
    await mutation().execute({ expectedContentRevision: 4 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(
      `/api/knowledge-documents/${documentId}/reparse`
    )
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedContentRevision: 4,
    })
    expect(cancel).toHaveBeenCalledWith({
      queryKey: ["knowledge-document", documentId],
    })
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toEqual(queued)
  })

  it("removes detail and invalidates the tree and counts only after successful deletion", async () => {
    queryClient.setQueryData(["knowledge-document", documentId], old)
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        id: documentId,
        knowledgeBaseId: "base-id",
      })
    )
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    useDeleteKnowledgeDocument(documentId)
    await mutation().execute(undefined)
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE")
    expect(
      queryClient.getQueryData(["knowledge-document", documentId])
    ).toBeUndefined()
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["knowledge-tree", "base-id"],
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["knowledge-bases"] })
  })

  it.each(["reparse", "delete"])(
    "preserves the cached body when %s fails and does not retry destructively",
    async (operation) => {
      queryClient.setQueryData(["knowledge-document", documentId], old)
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: { message: "操作失败" } }, { status: 409 })
      )
      if (operation === "reparse") useReparseKnowledgeDocument(documentId)
      else useDeleteKnowledgeDocument(documentId)
      await expect(
        mutation().execute({ expectedContentRevision: 4 })
      ).rejects.toMatchObject({ status: 409, message: "操作失败" })
      expect(
        queryClient.getQueryData(["knowledge-document", documentId])
      ).toEqual(old)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("downloads authenticated original bytes with the filename and releases the Blob URL", async () => {
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() }
    const appendChild = vi.fn()
    const createElement = vi.fn(() => link)
    const setTimeout = vi.fn()
    vi.stubGlobal("document", { createElement, body: { appendChild } })
    vi.stubGlobal("window", { setTimeout })
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:download")
    const revokeUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(new Response("原件内容"))
    await downloadKnowledgeDocumentOriginal(documentId, "报告.md")
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/api/knowledge-documents/${documentId}/original`
    )
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("include")
    const blob = createUrl.mock.calls[0][0]
    if (!(blob instanceof Blob))
      throw new Error("Download did not create a Blob")
    expect(await blob.text()).toBe("原件内容")
    expect(link.download).toBe("报告.md")
    expect(appendChild).toHaveBeenCalledWith(link)
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
    expect(revokeUrl).not.toHaveBeenCalled()
    setTimeout.mock.calls[0][0]()
    expect(revokeUrl).toHaveBeenCalledWith("blob:download")
  })

  it("does not download an error response as a file", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL")
    fetchMock.mockResolvedValueOnce(new Response("未认证", { status: 401 }))
    await expect(
      downloadKnowledgeDocumentOriginal(documentId, "报告.md")
    ).rejects.toMatchObject({ status: 401 })
    expect(createUrl).not.toHaveBeenCalled()
  })
})

describe("knowledge Markdown preview", () => {
  function render(content: string) {
    return renderToStaticMarkup(
      createElement(KnowledgeMarkdown, { documentId, content })
    )
  }

  it("renders headings, lists, tables and code", () => {
    const html = render(
      "# 标题\n\n- 列表\n\n| 名称 | 值 |\n| --- | --- |\n| A | B |\n\n```js\nconst x = 1\n```"
    )
    expect(html).toContain("<h1")
    expect(html).toContain("<li")
    expect(html).toContain("<table")
    expect(html).toContain("const x = 1")
  })

  it("does not execute raw HTML or unsafe Markdown links", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<iframe src="https://tracker.test"></iframe>\n\n[危险](javascript:alert%281%29)\n\n[安全](https://example.com)'
    )
    expect(html).not.toMatch(/<(script|iframe)\b/i)
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("renders diagram source without creating external image elements", () => {
    const html = render(
      '```mermaid\nflowchart LR\nA@{ img: "https://tracker.test/image.png" }\n```'
    )
    // SVG 图标来自代码控件，不应误判为 Mermaid 图表；真正的图表和图片不得出现。
    expect(html).not.toContain('data-streamdown="mermaid"')
    expect(html).not.toMatch(/<(img|image)\b/i)
    expect(html).toContain("https://tracker.test/image.png")
  })

  it("only loads authenticated images belonging to the current document", () => {
    const owned = `/api/knowledge-documents/${documentId}/assets/${assetName}`
    const html = render(
      `![本图](${owned})\n\n![外部](https://tracker.test/image.png)\n\n![他图](/api/knowledge-documents/other/assets/${assetName})\n\n![穿越](${owned}/../../secret)`
    )
    expect(html).toContain(`src="${owned}"`)
    expect(html).not.toContain('src="https://tracker.test')
    expect(html).not.toContain('src="/api/knowledge-documents/other')
    expect(html).not.toContain(
      'src="/api/knowledge-documents/' +
        documentId +
        "/assets/" +
        assetName +
        "/"
    )
    expect(html).toContain("图片未加载")
  })
})

describe("document preview states", () => {
  describe.each(["PDF", "DOCX", "TEXT"])("direct %s preview", (type) => {
    it.each(["QUEUED", "PARSING", "READY", "FAILED"])(
      "shows the original instead of the Markdown editor while %s",
      (status) => {
        const extension = type === "TEXT" ? "txt" : type.toLowerCase()
        queryClient.setQueryData(["knowledge-document", documentId], {
          document: {
            id: documentId,
            title: "测试文档",
            type,
            status,
            originalFileName: `测试.${extension}`,
            markdownContent: "# 不应显示的解析正文",
            contentRevision: 1,
            parseErrorMessage: "MinerU 服务返回错误",
          },
        })
        queryClient.setQueryData(["knowledge-file-preview", documentId], {
          fileName: `测试.${extension}`,
          kind: type === "TEXT" ? "text" : extension,
          url: "https://oss.example.test/original?signature=temporary",
          fileData: new ArrayBuffer(8),
          text: type === "TEXT" ? "# 原始纯文本\n  空格保留" : null,
        })
        vi.mocked(useQuery).mockImplementation((options) =>
          new QueryObserver(queryClient, options).getCurrentResult()
        )
        const html = renderToStaticMarkup(
          createElement(DocumentPreview, {
            documentId,
            onPreviewOriginal: vi.fn(),
          })
        )
        expect(html).toContain('aria-label="原件预览"')
        expect(html).toContain("刷新预览")
        expect(html).toContain("下载原件")
        expect(html).toContain('aria-label="文档操作"')
        expect(html).not.toContain("不应显示的解析正文")
        expect(html).not.toContain("MinerU 服务返回错误")
        expect(html).not.toContain("正文版本")
        expect(html).not.toContain('aria-label="Markdown 编辑与保存"')
        expect(html).not.toContain(">原件预览<")
        expect(html).not.toContain(">分屏<")
        expect(html).not.toContain("关闭预览")
        expect(html).not.toContain('role="dialog"')
        if (type === "TEXT") {
          expect(html).toContain("<pre")
          expect(html).toContain("# 原始纯文本\n  空格保留")
        }
        expect(fetchMock).not.toHaveBeenCalled()
      }
    )
  })

  it("keeps the selected document in the existing inline editor without a preview dialog", () => {
    queryClient.setQueryData(["knowledge-bases"], {
      items: [{ id: "base-id", name: "知识库" }],
    })
    queryClient.setQueryData(["knowledge-tree", "base-id"], {
      knowledgeBase: { id: "base-id", name: "知识库" },
      folders: [{ id: "folder-id", name: "测试目录", parentId: null }],
      documents: [
        { id: documentId, title: "测试文档", folderId: null, status: "READY" },
      ],
    })
    queryClient.setQueryData(["knowledge-document", documentId], {
      document: {
        id: documentId,
        title: "测试文档",
        type: "MARKDOWN",
        status: "READY",
        originalFileName: "笔记.md",
        markdownContent: "# 正文内容",
        contentRevision: 1,
      },
    })
    vi.mocked(useQuery).mockImplementation((options) =>
      new QueryObserver(queryClient, options).getCurrentResult()
    )
    const wrap = withNuqsTestingAdapter({
      searchParams: `?base=base-id&document=${documentId}`,
    })
    const html = renderToStaticMarkup(
      wrap({ children: createElement(KnowledgeWorkspace) })
    )
    expect(html).toContain("正文内容")
    expect(html).toContain('aria-label="根目录操作"')
    expect(html).toContain('aria-label="测试目录操作"')
    expect(html).toContain('aria-label="测试文档操作"')
    expect(html).not.toContain("置顶")
    expect(html).toContain("阅读")
    expect(html).toContain("编辑")
    expect(html).toContain("分屏")
    expect(html).toContain("原件预览")
    expect(html).not.toContain('aria-label="原件预览"')
    expect(html).not.toContain('role="dialog"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ["QUEUED", "等待解析任务执行"],
    ["PARSING", "正在转换为 Markdown"],
    ["FAILED", "MinerU 服务返回错误"],
    ["READY", "解析正文"],
  ])("renders %s without exposing unfinished content", (status, expected) => {
    useKnowledgeDocument(documentId)
    const options = queryOptions()
    queryClient.setQueryData(options.queryKey, {
      document: {
        id: documentId,
        title: "测试文档",
        type: "MARKDOWN",
        status,
        markdownContent: "# 解析正文",
        parseErrorMessage: "MinerU 服务返回错误",
      },
    })
    vi.mocked(useQuery).mockReturnValue(
      new QueryObserver(queryClient, options).getCurrentResult()
    )
    const html = renderToStaticMarkup(
      createElement(DocumentPreview, { documentId })
    )
    expect(html).toContain(expected)
    if (status !== "READY") expect(html).not.toContain("解析正文")
  })
})
