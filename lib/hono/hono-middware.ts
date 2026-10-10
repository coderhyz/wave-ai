"server-only"
import { createMiddleware } from "hono/factory"
import { auth } from "@/lib/auth"
import { HTTPException } from "hono/http-exception"

type Env = {
  Variables: {
    user: {
      id: string
      email: string
      name: string
      emailVerified: boolean
      createdAt: Date
      updatedAt: Date
    }
  }
}
// 验证用户身份的中间件
export const getAuthUser = createMiddleware<Env>(async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  if (!session) {
    throw new HTTPException(401, { message: "未认证" })
  }

  // 认证服务故障和下游业务异常交给全局错误处理，避免误报为未登录。
  c.set("user", session.user)
  await next()
})
