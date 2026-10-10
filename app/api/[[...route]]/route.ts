import { Hono } from "hono"
import { handle } from "hono/vercel"
import { HTTPException } from "hono/http-exception"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { noteRoute } from "./note"
import { chatRoute } from "./chat"
import { knowledgeBaseRoute } from "./knowledge-base"
import { knowledgeFolderRoute } from "./knowledge-folder"

export const runtime = "nodejs"

/** 整个 /api 命名空间共用的 Hono 应用实例。 */
const app = new Hono()

/**
 * 已知 HTTPException 保留原状态码；未处理异常统一记录日志并返回 500。
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error("Unhandled API error", err)
  return c.json({ error: "internal error" }, 500)
})

/**
 * 所有业务子路由都在这里挂载。
 * 保留完整链式表达式，AppType 才能为 Hono RPC 客户端推导具体路径类型。
 */
const routes = app
  .basePath("/api")
  .route("/note", noteRoute)
  .route("/chat", chatRoute)
  .route("/knowledge-bases", knowledgeBaseRoute)
  .route("/knowledge-folders", knowledgeFolderRoute)
  .get("/", getAuthUser, (c) => {
    return c.json({
      message: "Hello from Wave AI",
    })
  })

export type AppType = typeof routes

/** 将 Next.js Route Handler 支持的 HTTP 方法交给同一个 Hono 实例处理。 */
export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
