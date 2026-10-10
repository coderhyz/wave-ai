import { hc } from "hono/client"
import { useAuthToken } from "@/hooks/use-auth-token"
import type { AppType } from "@/app/api/[[...route]]/route"

const NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? ""

/** 为普通 API 和 AI 流式请求统一附加登录凭证。 */
export const fetchWithAuth: typeof fetch = (input, init) => {
  const token = useAuthToken.getState().bearerToken
  const headers = new Headers(init?.headers)

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  return fetch(input, {
    ...init,
    credentials: "include",
    headers,
  })
}

export const client = hc<AppType>(NEXT_PUBLIC_APP_URL, {
  fetch: fetchWithAuth,
})
// 通过 hc 创建的 client 可以直接调用 API 方法，返回 Promise 对象
export const api = client.api
