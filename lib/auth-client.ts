import { createAuthClient } from "better-auth/react"
import { useAuthToken } from "@/hooks/use-auth-token"; // path to your auth token store
// 客户端的配置
export const authClient = createAuthClient({
    fetchOptions: {
        auth: {
            type: "Bearer",
            token: () => useAuthToken.getState().bearerToken || "" // get the token from the auth token hook
        }
    }
})
// {
/** The base URL of the server (optional if you're using the same domain) */
//     baseURL: "http://localhost:3000"
// }
export const { signIn, signUp, useSession } = createAuthClient()