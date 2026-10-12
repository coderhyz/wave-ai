/**
 * 知识库文档接口。
 * 提供文档详情和解析图片读取，权限与 OSS 访问由文档服务统一处理。
 */
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import { getAuthUser } from "@/lib/hono/hono-middware"
import {
  getOwnedKnowledgeDocument,
  readOwnedKnowledgeDocumentAsset,
} from "@/lib/knowledge/document-service"
import { runKnowledgeApi } from "@/lib/knowledge/errors"
import { knowledgeIdParamSchema } from "@/lib/knowledge/schemas"

// 图片名由解析任务生成，只允许固定的 UUID、序号和图片扩展名格式。
const knowledgeAssetParamSchema = z
  .object({
    id: z.string().uuid(),
    assetName: z.string().regex(/^[0-9a-f-]{36}-\d{4}\.(?:png|jpe?g|webp)$/i),
  })
  .strict()

/** 文档详情和解析图片都经过知识库所有权校验，不暴露 OSS storageKey。 */
export const knowledgeDocumentRoute = new Hono()
  .get(
    "/:id/assets/:assetName",
    getAuthUser,
    zValidator("param", knowledgeAssetParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
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
