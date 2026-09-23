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
  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    })
    if (!session) {
      throw new HTTPException(401, { message: "未认证" })
    }
    // 如果 session 存在，将用户信息存储在上下文中，以便后续处理使用
    c.set("user", session.user)
    await next()
  } catch (error) {
    console.log(error)
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(401, { message: "未认证" })
  }
})
