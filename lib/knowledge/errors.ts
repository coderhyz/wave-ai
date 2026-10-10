import { HTTPException } from "hono/http-exception"

export type KnowledgeErrorCode =
  | "KNOWLEDGE_BASE_NOT_FOUND"
  | "KNOWLEDGE_FOLDER_NOT_FOUND"
  | "KNOWLEDGE_FOLDER_CYCLE"
  | "KNOWLEDGE_FOLDER_NOT_EMPTY"

type KnowledgeErrorStatus = 404 | 409

/** 可安全返回给前端的知识库业务错误。 */
export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
    readonly status: KnowledgeErrorStatus,
    readonly details?: Record<string, number | string>
  ) {
    super(message)
    this.name = "KnowledgeError"
  }
}

/** 构造知识库不存在或无权访问时使用的 404 错误。 */
export const knowledgeBaseNotFound = () =>
  new KnowledgeError("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在", 404)

/** 构造目录不存在、已删除或无权访问时使用的 404 错误。 */
export const knowledgeFolderNotFound = () =>
  new KnowledgeError("KNOWLEDGE_FOLDER_NOT_FOUND", "文件夹不存在", 404)

/** 构造目录移动会形成父子循环时使用的 409 错误。 */
export const knowledgeFolderCycle = () =>
  new KnowledgeError(
    "KNOWLEDGE_FOLDER_CYCLE",
    "文件夹不能移动到自身或其子目录",
    409
  )

/** 构造未确认递归删除非空目录时使用的 409 错误，并返回影响数量。 */
export const knowledgeFolderNotEmpty = (
  folderCount: number,
  documentCount: number
) =>
  new KnowledgeError(
    "KNOWLEDGE_FOLDER_NOT_EMPTY",
    "文件夹不是空目录，请确认递归删除",
    409,
    { folderCount, documentCount }
  )

/** 把领域错误转换成统一 JSON；未知异常继续交给全局 500 处理。 */
export const throwKnowledgeApiError = (error: unknown): never => {
  /** Hono 已经识别的 HTTP 异常保持原样，避免覆盖认证或参数校验状态码。 */
  if (error instanceof HTTPException) {
    throw error
  }

  if (error instanceof KnowledgeError) {
    /** 领域错误只向客户端暴露约定好的 code、message 和可选 details。 */
    throw new HTTPException(error.status, {
      res: Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        },
        { status: error.status }
      ),
    })
  }

  /** 未知错误不在此处伪装成业务错误，交给主路由的全局 500 处理器。 */
  throw error
}

/** 路由共用的错误边界，保持每个 Handler 只描述正常业务流程。 */
export const runKnowledgeApi = async <T>(
  callback: () => Promise<T>
): Promise<T> => {
  try {
    return await callback()
  } catch (error) {
    /** 所有知识库 Handler 共用同一套领域错误到 HTTP 响应的转换规则。 */
    return throwKnowledgeApiError(error)
  }
}
