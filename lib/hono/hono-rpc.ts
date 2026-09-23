import { hc } from "hono/client"
import { useAuthToken } from "@/hooks/use-auth-token"
import type { AppType } from "@/app/api/[[...route]]/route"

const NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? ""

const fetchWithAuth: typeof fetch = (input, init) => {
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

export const api = client.api
