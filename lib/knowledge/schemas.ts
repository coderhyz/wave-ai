/** 知识库接口共用的 Zod 参数结构，使各路由保持一致的输入规则。 */
import { z } from "zod"
import { normalizeText } from "@/lib/knowledge/parsers/normalize"
import { MAX_KNOWLEDGE_FILE_BYTES } from "@/lib/knowledge/parsers/types"

/** 知识库与目录接口共用的基础字段约束。 */
const knowledgeId = z.string().uuid()
const knowledgeName = z.string().trim().min(1).max(100)
const knowledgeDescription = z.string().trim().max(500).nullable()
const folderName = z.string().trim().min(1).max(100)
const sortOrder = z.number().int().min(0).max(2_147_483_647)

/** 向量模式用于独立验证召回，混合模式使用 ES 关键词与 RRF。 */
export const searchKnowledgeSchema = z
  .object({
    query: z
      .string()
      .max(2000)
      .transform((value) => normalizeText(value).trim())
      .pipe(z.string().min(1)),
    knowledgeBaseId: knowledgeId.optional(),
    documentId: knowledgeId.optional(),
    mode: z.enum(["vector", "hybrid"]).default("hybrid"),
    limit: z.number().int().min(1).max(20).default(6),
  })
  .strict()

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeSchema>

/** 所有知识库和文件夹路径参数统一使用 UUID。 */
export const knowledgeIdParamSchema = z.object({ id: knowledgeId }).strict()

/** 直传只向业务接口提交元数据，文件字节由浏览器直接发送到 OSS。 */
export const prepareKnowledgeDocumentUploadSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().max(200),
    sizeBytes: z.number().int().min(1).max(MAX_KNOWLEDGE_FILE_BYTES),
    folderId: knowledgeId.nullable().default(null),
  })
  .strict()

export const completeKnowledgeDocumentUploadSchema = z
  .object({ uploadId: knowledgeId })
  .strict()

export type PrepareKnowledgeDocumentUploadInput = z.infer<
  typeof prepareKnowledgeDocumentUploadSchema
>

/** 文件树重命名更新显示标题，不改变原文件类型和 OSS 对象键。 */
export const renameKnowledgeDocumentSchema = z
  .object({ title: z.string().trim().min(1).max(255) })
  .strict()

export type RenameKnowledgeDocumentInput = z.infer<
  typeof renameKnowledgeDocumentSchema
>

/** 重解析会替换正文，必须携带用户确认时看到的版本。 */
export const reparseKnowledgeDocumentSchema = z
  .object({
    expectedContentRevision: z.number().int().min(0).max(2_147_483_647),
  })
  .strict()

export type ReparseKnowledgeDocumentInput = z.infer<
  typeof reparseKnowledgeDocumentSchema
>

/** 创建知识库：名称必填，未提供描述时保存为 null。 */
export const createKnowledgeBaseSchema = z
  .object({
    name: knowledgeName,
    description: knowledgeDescription.optional().default(null),
  })
  .strict()

/** 更新知识库：至少提供名称或描述中的一个字段。 */
export const updateKnowledgeBaseSchema = z
  .object({
    name: knowledgeName.optional(),
    description: knowledgeDescription.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少提供一个需要更新的字段",
  })

/** 创建目录：parentId 为 null 表示知识库根级目录。 */
export const createKnowledgeFolderSchema = z
  .object({
    name: folderName,
    parentId: knowledgeId.nullable().optional().default(null),
    sortOrder: sortOrder.optional().default(0),
  })
  .strict()

/** 更新目录：parentId 用于移动目录，sortOrder 用于同级排序。 */
export const updateKnowledgeFolderSchema = z
  .object({
    name: folderName.optional(),
    parentId: knowledgeId.nullable().optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少提供一个需要更新的字段",
  })

/** 非空目录必须由调用方明确确认递归删除。 */
export const deleteKnowledgeFolderQuerySchema = z
  .object({
    recursive: z
      .enum(["true", "false"])
      .optional()
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict()

/** 经过 Zod 清洗后传入 service 层的知识库创建参数。 */
export type CreateKnowledgeBaseInput = z.infer<typeof createKnowledgeBaseSchema>
/** 经过 Zod 清洗后传入 service 层的知识库更新参数。 */
export type UpdateKnowledgeBaseInput = z.infer<typeof updateKnowledgeBaseSchema>
/** 经过 Zod 清洗后传入 service 层的目录创建参数。 */
export type CreateKnowledgeFolderInput = z.infer<
  typeof createKnowledgeFolderSchema
>
/** 经过 Zod 清洗后传入 service 层的目录更新参数。 */
export type UpdateKnowledgeFolderInput = z.infer<
  typeof updateKnowledgeFolderSchema
>
