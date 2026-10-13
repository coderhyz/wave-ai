/**
 * 知识库文档接口。
 * 提供文档详情、只读预览、原件下载、重解析及删除，统一验证资源所有权。
 */
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import { getAuthUser } from "@/lib/hono/hono-middware"
import {
  getOwnedKnowledgeDocument,
  readOwnedKnowledgeDocumentAsset,
  readOwnedKnowledgeDocumentOriginal,
  reparseKnowledgeDocument,
  getOwnedKnowledgeFilePreview,
  renameKnowledgeDocument,
} from "@/lib/knowledge/documents/document-service"
import { deleteKnowledgeDocument } from "@/lib/knowledge/management/service"
import { runKnowledgeApi } from "@/lib/knowledge/errors"
import {
  knowledgeIdParamSchema,
  reparseKnowledgeDocumentSchema,
  renameKnowledgeDocumentSchema,
} from "@/lib/knowledge/schemas"

// 图片名由解析任务生成，只允许固定的 UUID、序号和图片扩展名格式。
const knowledgeAssetParamSchema = z
  .object({
    id: z.string().uuid(),
    assetName: z.string().regex(/^[0-9a-f-]{36}-\d{4}\.(?:png|jpe?g|webp)$/i),
  })
  .strict()

/** 文档详情和解析图片都经过知识库所有权校验，不暴露 OSS storageKey。 */
export const knowledgeDocumentRoute = new Hono()
  /** 文件显示名称是元数据，与解析正文及原件存储相互独立。 */
  .patch(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    zValidator("json", renameKnowledgeDocumentSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const document = await renameKnowledgeDocument(
          c.get("user").id,
          c.req.valid("param").id,
          c.req.valid("json")
        )
        return c.json({ success: true, document })
      })
  )
  .get(
    "/:id/preview",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const file = await getOwnedKnowledgeFilePreview(
          c.get("user").id,
          c.req.valid("param").id
        )
        // 签名 URL 是临时访问凭证，不允许被共享缓存或写入持久正文。
        c.header("Cache-Control", "private, no-store")
        return c.json({ success: true, file })
      })
  )
  .get(
    "/:id/original",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const { content, filename } = await readOwnedKnowledgeDocumentOriginal(
          c.get("user").id,
          c.req.valid("param").id
        )
        // 附件下载而非内联渲染；UTF-8 文件名经编码后不能注入响应头。
        const encoded = encodeURIComponent(filename.toWellFormed()).replace(
          /['()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        )
        return new Response(new Uint8Array(content), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
            "Content-Length": String(content.byteLength),
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
          },
        })
      })
  )
  .post(
    "/:id/reparse",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    zValidator("json", reparseKnowledgeDocumentSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const document = await reparseKnowledgeDocument(
          c.get("user").id,
          c.req.valid("param").id,
          c.req.valid("json")
        )
        return c.json({ success: true, document }, 202)
      })
  )
  .delete(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const deleted = await deleteKnowledgeDocument(
          c.get("user").id,
          c.req.valid("param").id
        )
        return c.json({ success: true, ...deleted })
      })
  )
  .get(
    "/:id/assets/:assetName",
    getAuthUser,
    zValidator("param", knowledgeAssetParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        // assetName 由解析任务生成，必须是 UUID + 序号 + 图片扩展名的固定格式。
        const { id, assetName } = c.req.valid("param")
        const { content, mediaType } = await readOwnedKnowledgeDocumentAsset(
          user.id,
          id,
          assetName
        )
        // 仅允许当前用户私有缓存，并禁止浏览器把图片响应解释成可执行内容。
        return new Response(new Uint8Array(content), {
          headers: {
            "Cache-Control": "private, max-age=300",
            "Content-Length": String(content.byteLength),
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Type": mediaType,
            "X-Content-Type-Options": "nosniff",
          },
        })
      })
  )
  .get(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const document = await getOwnedKnowledgeDocument(user.id, id)
        return c.json({ success: true, document })
      })
  )
