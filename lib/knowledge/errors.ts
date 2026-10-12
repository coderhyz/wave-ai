/**
 * 知识库模块统一错误定义。
 * Service 抛出领域错误，API 层在这里把它转换成固定的 HTTP JSON 响应。
 */
import { HTTPException } from "hono/http-exception"
import { KnowledgeParseError } from "@/lib/knowledge/parsers/types"

export type KnowledgeErrorCode =
  | "KNOWLEDGE_BASE_NOT_FOUND"
  | "KNOWLEDGE_FOLDER_NOT_FOUND"
  | "KNOWLEDGE_DOCUMENT_NOT_FOUND"
  | "KNOWLEDGE_FOLDER_CYCLE"
  | "KNOWLEDGE_FOLDER_NOT_EMPTY"
  | "KNOWLEDGE_DOCUMENT_NOT_READY"
  | "CONTENT_REVISION_CONFLICT"
  | "KNOWLEDGE_DOCUMENT_NO_ORIGINAL"
  | "KNOWLEDGE_DOCUMENT_PROCESSING"

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

/** 构造文档不存在、已删除或无权访问时使用的 404 错误。 */
export const knowledgeDocumentNotFound = () =>
  new KnowledgeError("KNOWLEDGE_DOCUMENT_NOT_FOUND", "知识库文档不存在", 404)

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

/** 路由共用的错误边界，保持每个 Handler 只描述正常业务流程。 */
export const runKnowledgeApi = async <T>(
  callback: () => Promise<T>
): Promise<T> => {
  try {
    return await callback()
  } catch (error) {
    if (
      error instanceof KnowledgeError ||
      error instanceof KnowledgeParseError
    ) {
      throw new HTTPException(error.status, {
        res: Response.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error instanceof KnowledgeError && error.details
                ? { details: error.details }
                : {}),
            },
          },
          { status: error.status }
        ),
      })
    }

    // 认证异常和未知错误原样交给全局处理，保留原有状态码及日志。
    throw error
  }
}
