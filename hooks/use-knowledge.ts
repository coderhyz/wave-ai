"use client"

/**
 * 知识库页面的数据访问入口。
 *
 * 读取操作通过 useQuery 获取数据；新增、修改、删除和上传通过 useMutation 执行。
 * mutationFn 描述请求步骤，onSuccess 更新成功后的缓存，onError 处理失败后的刷新，
 * onSettled 则在成功、失败两种情况下都执行，确保界面显示服务端的最终状态。
 *
 * 主要缓存键：
 * - knowledge-bases：知识库列表。
 * - knowledge-tree + 知识库 ID：该库的目录和文档摘要。
 * - knowledge-document + 文档 ID：正文、解析状态等文档详情。
 * - knowledge-file-preview + 文档 ID：原件签名地址及预览所需的字节或文本。
 *
 * api 沿用项目的 Cookie/Bearer 鉴权；直接访问 OSS 时使用签名授权和原生 fetch。
 * 本文件负责界面数据和缓存衔接，权限检查及文件内容校验由后端执行。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { InferRequestType, InferResponseType } from "hono/client"
import type { KnowledgeError } from "@/lib/knowledge/errors"
import { api } from "@/lib/hono/hono-rpc"
import {
  decodeOriginalText,
  getFilePreviewKind,
} from "@/lib/knowledge/documents/file-preview"

// Hono RPC 子路由别名：请求参数和响应类型仍由后端路由推导，无需重复定义接口。
const bases = api["knowledge-bases"]
const documents = api["knowledge-documents"]
const folders = api["knowledge-folders"]

/**
 * 修改文档标题。
 * 1. 向文档 PATCH 接口提交新标题，失败时抛出统一请求错误。
 * 2. 成功后取消该文档正在进行的详情查询，避免旧响应覆盖刚修改的标题。
 * 3. 将返回的元数据合入现有详情，保留响应中未包含的解析正文等字段。
 * 4. 将所属知识库的树缓存标记过期，使目录中的标题也能刷新。
 */
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

/**
 * 修改目录名称。
 * 1. 调用目录 PATCH 接口，只提交 name，不修改 parentId 或排序。
 * 2. 检查响应并返回服务端结果；失败交给调用方显示。
 * 3. 成功后刷新所属知识库的树，让目录名称与服务端保持一致。
 */
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

/**
 * 删除目录及其子树；调用方的确认框负责明确提示删除范围。
 * 1. 传入 recursive=true，明确要求后端执行递归删除。
 * 2. 根据服务端返回的 documentIds，逐个取消文档详情和原件预览的在途查询。
 * 3. 移除这些文档的缓存，避免已删除文件继续显示或被旧响应重新写回缓存。
 * 4. 刷新当前知识库的树和知识库列表，更新目录结构及文档统计。
 */
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

/**
 * 删除整座知识库，根目录菜单也复用此操作。
 * 1. 调用知识库 DELETE 接口，只有成功响应才进入缓存清理。
 * 2. 取消并移除该库的树查询，再按返回的文档 ID 清理详情与预览缓存。
 * 3. 立即从已有知识库列表缓存中移除该库，使界面及时响应。
 * 4. 再将列表标记过期，通过后续查询与服务端重新同步。
 */
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

/**
 * 独立读取原件预览，不依赖解析后的 Markdown 正文。
 * 1. documentId 非空时，请求后端鉴权后的预览信息和 OSS 短期签名地址。
 * 2. 根据文件名、MIME 判断预览类型，使用签名地址下载所需的原件字节。
 * 3. PDF/DOCX 把字节交给阅读器；文本/Markdown 解码为正文；其他类型返回元信息。
 * 4. 将 Query 的 AbortSignal 传给两次请求，便于取消过时的预览读取。
 * 5. 查询无观察者后立即回收缓存，下次打开重新鉴权和签名。
 */
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
    // 已加载结果在十分钟内视为新鲜；这不会延长 OSS 签名本身的有效期。
    staleTime: 10 * 60 * 1000,
    // 关闭预览且无组件继续订阅该查询时，立即释放原件字节占用的缓存。
    gcTime: 0,
    // 已加载的正文无需随窗口焦点反复下载；过期/加载失败由刷新按钮重新签名。
    refetchOnWindowFocus: false,
  })
}

// 直接提取后端响应类型：树保留整个响应结构，文档类型取响应中的 document 字段。
export type KnowledgeTree = InferResponseType<
  (typeof bases)[":id"]["tree"]["$get"]
>
export type KnowledgeDocument = InferResponseType<
  (typeof documents)[":id"]["$get"]
>["document"]

/**
 * 前端统一请求错误。
 * message 用于界面提示，status 保留 HTTP 状态，details 保留业务附加信息。
 * 上传处理失败时，details.documentId 可用于刷新已保存但未处理成功的文档。
 */
export class KnowledgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: KnowledgeError["details"]
  ) {
    super(message)
    this.name = "KnowledgeRequestError"
  }
}

/**
 * 将非成功响应转换为抛出的异常，让 Query/Mutation 进入错误状态。
 * 1. JSON 响应兼容 error 字符串和 error.message 对象两种已有格式。
 * 2. error 为对象时保留 details，便于调用方定位已保存的文档等资源。
 * 3. 非 JSON 响应读取纯文本；缺少错误说明时使用 HTTP 状态作为提示。
 * 此函数总会抛出异常，所以返回类型为 Promise<never>，不会把失败当作正常数据返回。
 */
async function throwRequestError(response: Response): Promise<never> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await response.json()
    throw new KnowledgeRequestError(
      (typeof body.error === "string" ? body.error : body.error?.message) ??
        `请求失败（${response.status}）`,
      response.status,
      typeof body.error === "object" ? body.error?.details : undefined
    )
  }
  throw new KnowledgeRequestError(
    (await response.text()) || `请求失败（${response.status}）`,
    response.status
  )
}

/**
 * 重新解析并建立文档索引。
 * 1. 向 reparse 接口提交参数，并等待服务端实际处理结束。
 * 2. 成功时取消旧详情查询，把返回的完整文档结果写入详情缓存。
 * 3. 失败时刷新详情，因为服务端可能已保存正文或更新失败状态。
 * 4. 无论结果如何，都将树缓存标记过期，同步解析状态等摘要信息。
 */
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
    },
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: ["knowledge-document", documentId],
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] }),
  })
}

/**
 * 删除单篇文档。
 * 1. 调用文档 DELETE 接口，失败时保留现有正文与预览缓存。
 * 2. 成功后先取消详情和预览的在途查询，再移除对应缓存。
 * 3. 刷新所属知识库的树和知识库列表，更新文档列表及统计。
 */
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

/**
 * 下载文档原件。
 * 1. 通过现有鉴权客户端请求原件，支持 Cookie 和 Bearer 登录方式。
 * 2. 先检查响应是否成功，避免把错误说明当作文件下载。
 * 3. 将响应转成 Blob，创建浏览器临时 URL 和带 download 属性的链接。
 * 4. 触发下载并移除临时链接，稍后释放 Blob URL，避免中断浏览器读取。
 */
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

/**
 * 读取当前登录用户的知识库列表。
 * 1. 使用固定缓存键共享列表数据，鉴权沿用项目 RPC 客户端。
 * 2. 传递查询的 AbortSignal，使取消查询时能够中止网络请求。
 * 3. 检查响应后返回 JSON，失败则交给 Query 的 error 状态展示。
 */
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

/**
 * 读取指定知识库的目录树与文档摘要。
 * 1. 将知识库 ID 放入缓存键，避免切库时混用不同知识库的数据。
 * 2. ID 非空时才发送查询，并传递 AbortSignal 以支持取消。
 * 3. 只返回树摘要；用户选择文档后，再由详情 Hook 单独加载正文。
 */
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
  })
}

/**
 * 读取单篇文档详情。
 * 1. 以文档 ID 区分缓存，未选择文档时禁用查询。
 * 2. 请求中传递 AbortSignal，切换文档等取消场景可中止旧读取。
 * 3. 返回服务端详情；后续修改操作通过 Mutation 更新或刷新该缓存。
 */
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
  })
}

/**
 * 创建知识库。
 * 1. 将名称提交到知识库创建接口，检查响应并返回创建结果。
 * 2. 成功后刷新知识库列表；失败保留异常，交给调用方的名称表单显示。
 */
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

/**
 * 在指定知识库下创建目录。
 * 1. 提交名称与 parentId；parentId=null 表示创建在知识库根级。
 * 2. 后端校验用户所有权和目录结构约束，前端检查并返回响应。
 * 3. 成功后刷新当前库的树及知识库列表，使目录和统计同步更新。
 */
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

/**
 * 上传知识库文件：申请凭证 → 浏览器直传 OSS → 通知后端确认并处理。
 *
 * 浏览器上传文件时直接将字节发送到 OSS，业务接口只接收元数据或 uploadId。
 * 后端确认时仍会读取原件进行校验，并等待解析与索引完成后返回；
 * 因此 isPending 覆盖整个流程，OSS 上传结束不代表文档已经可以检索。
 * 失败时服务端可能已经保存部分处理结果，下面的回调会同步这些状态。
 */
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
      // 第 1 步：提交文件名、MIME、大小和目标目录，申请本次上传的短期签名。
      // RPC 客户端附带应用登录凭证；后端验证权限并先登记失败清理记录。
      const prepared = await bases[":id"].documents["upload-url"].$post({
        param: { id: knowledgeBaseId },
        json: {
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          folderId,
        },
      })
      // 第 2 步：申请失败时立即终止；成功后取得签名 URL、绑定请求头和 uploadId。
      // uploadId 用于后端定位本次登记，前端无需自行构造或提交 OSS 对象键。
      if (!prepared.ok) await throwRequestError(prepared)
      const { upload } = await prepared.json()
      // 第 3 步：直接把原始 File 作为 PUT 请求体发送给 OSS，不经过 Vercel 转发。
      // 请求头必须与签名一致；Content-Length 由浏览器根据 File 自动生成。
      // 使用原生 fetch 和 credentials=omit，避免把应用的 Bearer/Cookie 带给 OSS。
      const uploaded = await fetch(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: file,
        credentials: "omit",
      })
      // 第 4 步：OSS 返回失败状态时停止，不向后端谎报上传完成。
      // fetch 的网络异常也会直接向上抛出，由 Mutation 统一进入失败状态。
      if (!uploaded.ok)
        throw new Error(`文件直传失败（${uploaded.status}），请稍后重试`)
      // 第 5 步：上传完成后只提交 uploadId，通知后端读取并校验本次原件。
      // 后端会将校验通过的临时对象复制为正式原件，并执行原有解析与索引流程。
      const response = await bases[":id"].documents.$post({
        param: { id: knowledgeBaseId },
        json: { uploadId: upload.uploadId },
      })
      // 第 6 步：确认或处理失败时保留服务端错误；全部完成才返回完整文档结果。
      if (!response.ok) await throwRequestError(response)
      return (await response.json()) as {
        success: true
        document: KnowledgeDocument
      }
    },
    // 不自动重跑整条上传链路，避免重复申请对象或重复确认已经处理的上传。
    retry: false,
    onSuccess: async (data) => {
      // 第 7 步：成功后取消旧详情请求，再写入完整结果，避免旧响应覆盖最新内容。
      await queryClient.cancelQueries({
        queryKey: ["knowledge-document", data.document.id],
      })
      queryClient.setQueryData(["knowledge-document", data.document.id], data)
    },
    onError: (error) => {
      // 第 8 步：如果后端已保存文档并在错误中返回其 ID，就刷新该文档详情。
      // 例如原件已保存但解析/索引失败，界面仍应显示实际失败状态和原因。
      if (error instanceof KnowledgeRequestError && error.details?.documentId) {
        return queryClient.invalidateQueries({
          queryKey: ["knowledge-document", error.details.documentId],
        })
      }
    },
    onSettled: async () => {
      // 第 9 步：成功或失败都并行刷新所属库的树及知识库列表。
      // 即使请求失败，也可能已有文档落库；等待失效处理完成后再结束此次 Mutation。
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["knowledge-tree", knowledgeBaseId],
        }),
        queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] }),
      ])
    },
  })
}
