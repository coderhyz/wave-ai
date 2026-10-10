import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { runKnowledgeApi } from "@/lib/knowledge/errors"
import {
  deleteKnowledgeFolderQuerySchema,
  knowledgeIdParamSchema,
  updateKnowledgeFolderSchema,
} from "@/lib/knowledge/schemas"
import {
  deleteKnowledgeFolder,
  updateKnowledgeFolder,
} from "@/lib/knowledge/service"

/**
 * 文件夹接口：重命名、排序、同库移动和递归软删除。
 * route.ts 会将本路由挂载到 /api/knowledge-folders。
 * 路由层只负责认证、参数校验和响应组装，事务与目录规则集中在 service 层。
 */
export const knowledgeFolderRoute = new Hono()
  /** 重命名、排序或移动文件夹；service 层负责同库与防循环检查。 */
  .patch(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    zValidator("json", updateKnowledgeFolderSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const folder = await updateKnowledgeFolder(
          user.id,
          id,
          c.req.valid("json")
        )
        return c.json({ success: true, folder })
      })
  )
  /** 删除目录；非空目录只有在 recursive=true 时才允许递归删除。 */
  .delete(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    zValidator("query", deleteKnowledgeFolderQuerySchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const { recursive } = c.req.valid("query")
        const deleted = await deleteKnowledgeFolder(user.id, id, recursive)
        return c.json({ success: true, deleted })
      })
  )
