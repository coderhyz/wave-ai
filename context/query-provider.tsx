import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * 提供 React Query 的上下文，允许在应用程序中使用 React Query 进行数据获取和缓存。
 * @param param0 The props for the QueryProvider component.
 * @returns The QueryProvider component.
 */
function QueryProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  // 每次渲染复用同一个实例，保留已获取的数据和请求状态。
  const [queryClient] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

export default QueryProvider
