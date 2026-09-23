import { auth } from "@/lib/auth" // path to your auth file
// TODO 必须配置这个 API 路由来处理认证相关的请求。这个路由会被 better-auth 自动使用。
import { toNextJsHandler } from "better-auth/next-js"
export const { POST, GET } = toNextJsHandler(auth)
