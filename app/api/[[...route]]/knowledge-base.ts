import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { runKnowledgeApi } from "@/lib/knowledge/errors"
import {
  createKnowledgeBaseSchema,
  createKnowledgeFolderSchema,
  knowledgeIdParamSchema,
  updateKnowledgeBaseSchema,
} from "@/lib/knowledge/schemas"
import {
  createKnowledgeBase,
  createKnowledgeFolder,
  deleteKnowledgeBase,
  getKnowledgeTree,
  listKnowledgeBases,
  updateKnowledgeBase,
} from "@/lib/knowledge/service"

/**
 * 知识库根接口：列表、创建、元数据更新、软删除、树摘要和文件夹创建。
 * route.ts 会将本路由挂载到 /api/knowledge-bases。
 * 每个接口先由 getAuthUser 注入可信用户，再由 zValidator 校验输入，最后调用 service。
 */
export const knowledgeBaseRoute = new Hono()
  /** 获取当前登录用户的知识库列表。 */
  .get("/", getAuthUser, async (c) =>
    runKnowledgeApi(async () => {
      const user = c.get("user")
      const items = await listKnowledgeBases(user.id)
      return c.json({ success: true, items })
    })
  )
  /** 创建知识库，请求 JSON 会先经过 createKnowledgeBaseSchema 校验。 */
  .post(
    "/",
    getAuthUser,
    zValidator("json", createKnowledgeBaseSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const knowledgeBase = await createKnowledgeBase(
          user.id,
          c.req.valid("json")
        )
        return c.json({ success: true, knowledgeBase }, 201)
      })
  )
  /** 获取文件树摘要，不在此接口返回文档正文和存储信息。 */
  .get(
    "/:id/tree",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const tree = await getKnowledgeTree(user.id, id)
        return c.json({ success: true, ...tree })
      })
  )
  /** 在知识库根级或指定父目录下创建文件夹。 */
  .post(
    "/:id/folders",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    zValidator("json", createKnowledgeFolderSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const folder = await createKnowledgeFolder(
          user.id,
          id,
          c.req.valid("json")
        )
        return c.json({ success: true, folder }, 201)
      })
  )
  /** 修改知识库名称或描述。 */
  .patch(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    zValidator("json", updateKnowledgeBaseSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const knowledgeBase = await updateKnowledgeBase(
          user.id,
          id,
          c.req.valid("json")
        )
        return c.json({ success: true, knowledgeBase })
      })
  )
  /** 软删除知识库，并由 service 层处理目录、文档和清理任务。 */
  .delete(
    "/:id",
    getAuthUser,
    zValidator("param", knowledgeIdParamSchema),
    async (c) =>
      runKnowledgeApi(async () => {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const deleted = await deleteKnowledgeBase(user.id, id)
        return c.json({ success: true, deleted })
      })
  )
