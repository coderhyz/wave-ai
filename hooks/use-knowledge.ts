"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { InferRequestType, InferResponseType } from "hono/client"
import { api, fetchWithAuth } from "@/lib/hono/hono-rpc"
import {
  decodeOriginalText,
  getFilePreviewKind,
} from "@/lib/knowledge/documents/file-preview"

const bases = api["knowledge-bases"]
const documents = api["knowledge-documents"]
const folders = api["knowledge-folders"]

/** 标题更新只合并元数据，不能用部分响应覆盖解析正文。 */
export function useRenameKnowledgeDocument(documentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      json: InferRequestType<(typeof documents)[":id"]["$patch"]>["json"]
    ) => {
      const response = await documents[":id"].$patch({
        param: { id: documentId },
        json,
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    onSuccess: async ({ document }) => {
      await queryClient.cancelQueries({
        queryKey: ["knowledge-document", documentId],
      })
      queryClient.setQueryData<{ document: KnowledgeDocument }>(
        ["knowledge-document", documentId],
        (current) =>
          current
            ? { ...current, document: { ...current.document, ...document } }
            : undefined
      )
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", document.knowledgeBaseId],
      })
    },
  })
}

/** 复用目录 PATCH，菜单只提交 name，不改 parentId 或排序。 */
export function useRenameKnowledgeFolder(
  folderId: string,
  knowledgeBaseId: string
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (json: { name: string }) => {
      const response = await folders[":id"].$patch({
        param: { id: folderId },
        json,
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", knowledgeBaseId],
      }),
  })
}

/** 确认框已明确说明删除子树；成功后清除旧详情，避免已删除文件继续留在预览缓存。 */
export function useDeleteKnowledgeFolder(
  folderId: string,
  knowledgeBaseId: string
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const response = await folders[":id"].$delete({
        param: { id: folderId },
        query: { recursive: "true" },
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    onSuccess: async ({ deleted }) => {
      // 使用服务端实际删除的 ID，保留其他目录的详情缓存。
      await Promise.all(
        deleted.documentIds.map(async (id) => {
          await queryClient.cancelQueries({
            queryKey: ["knowledge-document", id],
          })
          await queryClient.cancelQueries({
            queryKey: ["knowledge-file-preview", id],
          })
          queryClient.removeQueries({ queryKey: ["knowledge-document", id] })
          queryClient.removeQueries({
            queryKey: ["knowledge-file-preview", id],
          })
        })
      )
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", knowledgeBaseId],
      })
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] })
    },
  })
}

/** 根目录对应整座知识库，直接调用现有整库删除接口。 */
export function useDeleteKnowledgeBase(knowledgeBaseId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const response = await bases[":id"].$delete({
        param: { id: knowledgeBaseId },
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    onSuccess: async ({ deleted }) => {
      await queryClient.cancelQueries({
        queryKey: ["knowledge-tree", knowledgeBaseId],
      })
      queryClient.removeQueries({
        queryKey: ["knowledge-tree", knowledgeBaseId],
      })
      await Promise.all(
        deleted.documentIds.map(async (id) => {
          await queryClient.cancelQueries({
            queryKey: ["knowledge-document", id],
          })
          await queryClient.cancelQueries({
            queryKey: ["knowledge-file-preview", id],
          })
          queryClient.removeQueries({ queryKey: ["knowledge-document", id] })
          queryClient.removeQueries({
            queryKey: ["knowledge-file-preview", id],
          })
        })
      )
      queryClient.setQueryData<InferResponseType<(typeof bases)["$get"]>>(
        ["knowledge-bases"],
        (current) =>
          current
            ? {
                ...current,
                items: current.items.filter(({ id }) => id !== knowledgeBaseId),
              }
            : undefined
      )
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] })
    },
  })
}

/** 原件独立加载；关闭预览便释放缓存，下次打开重新鉴权并获取新签名。 */
export function useKnowledgeFilePreview(documentId: string) {
  return useQuery({
    queryKey: ["knowledge-file-preview", documentId],
    enabled: Boolean(documentId),
    queryFn: async ({ signal }) => {
      const response = await documents[":id"].preview.$get(
        { param: { id: documentId } },
        { init: { signal } }
      )
      if (!response.ok) await throwRequestError(response)
      const { file } = await response.json()
      const kind = getFilePreviewKind(file.fileName, file.mimeType)
      if (
        kind === "text" ||
        kind === "markdown" ||
        kind === "pdf" ||
        kind === "docx"
      ) {
        // OSS 签名本身提供授权，不能把应用的 Bearer/Cookie 转发到 OSS。
        const original = await fetch(file.url, { signal, credentials: "omit" })
        if (!original.ok) await throwRequestError(original)
        const buffer = await original.arrayBuffer()
        // 阅读器默认加载器会吞掉网络错误；统一在 Query 检查失败，并传入字节避免二次下载。
        if (kind === "pdf" || kind === "docx")
          return { ...file, kind, fileData: buffer, text: null } as const
        return { ...file, kind, text: decodeOriginalText(buffer) } as const
      }
      return { ...file, kind, text: null } as const
    },
    retry: false,
    staleTime: 10 * 60 * 1000,
    gcTime: 0,
    // 已加载的正文无需随窗口焦点反复下载；过期/加载失败由刷新按钮重新签名。
    refetchOnWindowFocus: false,
  })
}

export type KnowledgeTree = InferResponseType<
  (typeof bases)[":id"]["tree"]["$get"]
>
export type KnowledgeDocument = InferResponseType<
  (typeof documents)[":id"]["$get"]
>["document"]

// 领域错误返回 JSON，HTTPException 也可能返回纯文本；两者都应显示真实原因。
// 保留 HTTP 状态，文档操作才能区分版本冲突和网络/服务器错误。
export class KnowledgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "KnowledgeRequestError"
  }
}

async function throwRequestError(response: Response): Promise<never> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await response.json()
    throw new KnowledgeRequestError(
      (typeof body.error === "string" ? body.error : body.error?.message) ??
        `请求失败（${response.status}）`,
      response.status
    )
  }
  throw new KnowledgeRequestError(
    (await response.text()) || `请求失败（${response.status}）`,
    response.status
  )
}

/** 重解析入队后继续沿用详情轮询；不乐观地伪造解析成功。 */
export function useReparseKnowledgeDocument(documentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      json: InferRequestType<
        (typeof documents)[":id"]["reparse"]["$post"]
      >["json"]
    ) => {
      const response = await documents[":id"].reparse.$post({
        param: { id: documentId },
        json,
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    onSuccess: async (data) => {
      await queryClient.cancelQueries({
        queryKey: ["knowledge-document", documentId],
      })
      queryClient.setQueryData(["knowledge-document", documentId], data)
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", data.document.knowledgeBaseId],
      })
    },
  })
}

/** 删除成功才移除详情缓存；失败保留正文和当前选择。 */
export function useDeleteKnowledgeDocument(documentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const response = await documents[":id"].$delete({
        param: { id: documentId },
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    onSuccess: async (data) => {
      await queryClient.cancelQueries({
        queryKey: ["knowledge-document", documentId],
      })
      queryClient.removeQueries({
        queryKey: ["knowledge-document", documentId],
      })
      await queryClient.cancelQueries({
        queryKey: ["knowledge-file-preview", documentId],
      })
      queryClient.removeQueries({
        queryKey: ["knowledge-file-preview", documentId],
      })
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", data.knowledgeBaseId],
      })
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] })
    },
  })
}

/** 下载也走现有鉴权客户端，支持 Cookie 和 Bearer；失败不能下载成错误文本文件。 */
export async function downloadKnowledgeDocumentOriginal(
  documentId: string,
  filename: string
) {
  const response = await documents[":id"].original.$get({
    param: { id: documentId },
  })
  if (!response.ok) await throwRequestError(response)
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 浏览器开始读取下载链接后再释放 Blob，避免立即 revoke 中断下载。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 列表仅包含当前登录用户的知识库；鉴权沿用项目 RPC 客户端。 */
export function useKnowledgeBases() {
  return useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: async ({ signal }) => {
      const response = await bases.$get({}, { init: { signal } })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
  })
}

/** 树接口只读取摘要，点击文档后再单独加载正文，避免一次传输所有内容。 */
export function useKnowledgeTree(knowledgeBaseId: string) {
  return useQuery({
    queryKey: ["knowledge-tree", knowledgeBaseId],
    enabled: Boolean(knowledgeBaseId),
    queryFn: async ({ signal }) => {
      const response = await bases[":id"].tree.$get(
        { param: { id: knowledgeBaseId } },
        { init: { signal } }
      )
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    // 目录摘要也随任务刷新，未被选中的文档不会一直显示旧状态。
    refetchInterval: (query) =>
      !query.state.error &&
      query.state.data?.documents.some(
        ({ status }) => status === "QUEUED" || status === "PARSING"
      )
        ? 3000
        : false,
  })
}

/** 切换文档时取消旧请求；终态或请求失败后停止轮询，由用户手动重新读取。 */
export function useKnowledgeDocument(documentId: string) {
  return useQuery({
    queryKey: ["knowledge-document", documentId],
    enabled: Boolean(documentId),
    queryFn: async ({ signal }) => {
      const response = await documents[":id"].$get(
        { param: { id: documentId } },
        { init: { signal } }
      )
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    retry: false,
    // 复用详情接口读取任务状态，不另建状态 API 或定时器。
    refetchInterval: (query) => {
      const status = query.state.data?.document.status
      const chunkStatus = query.state.data?.document.chunkStatus
      return !query.state.error &&
        (status === "QUEUED" ||
          status === "PARSING" ||
          (status === "READY" &&
            (chunkStatus === "PENDING" || chunkStatus === "RUNNING")))
        ? 3000
        : false
    },
  })
}

/** 创建成功后刷新列表，失败保留原错误交给名称表单显示。 */
export function useCreateKnowledgeBase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      const response = await bases.$post({ json: { name } })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] }),
  })
}

/** parentId=null 表示根目录；后端负责所有权和目录结构约束。 */
export function useCreateKnowledgeFolder(knowledgeBaseId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      name,
      parentId,
    }: {
      name: string
      parentId: string | null
    }) => {
      const response = await bases[":id"].folders.$post({
        param: { id: knowledgeBaseId },
        json: { name, parentId },
      })
      if (!response.ok) await throwRequestError(response)
      return response.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", knowledgeBaseId],
      })
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] })
    },
  })
}

/** 上传返回排队中的文档，先写入详情缓存，再由详情和文件树继续轮询。 */
export function useUploadKnowledgeDocument(knowledgeBaseId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      file,
      folderId,
    }: {
      file: File
      folderId: string | null
    }) => {
      const form = new FormData()
      form.set("file", file)
      if (folderId) form.set("folderId", folderId)
      // 此接口在服务端手动读取 multipart，Hono RPC 没有对应的 form 参数类型。
      const response = await fetchWithAuth(
        `/api/knowledge-bases/${knowledgeBaseId}/documents`,
        {
          method: "POST",
          body: form,
        }
      )
      if (!response.ok) await throwRequestError(response)
      return (await response.json()) as {
        success: true
        document: KnowledgeDocument
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["knowledge-document", data.document.id], data)
      queryClient.invalidateQueries({
        queryKey: ["knowledge-tree", data.document.knowledgeBaseId],
      })
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] })
    },
  })
}
