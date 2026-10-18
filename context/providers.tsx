"use client"

import React, { ReactNode, useEffect } from "react"
import QueryProvider from "./query-provider"
import { Toaster } from "sonner"
import { ThemeProvider } from "./theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useChatUiStore } from "@/stores/chat-ui-store"

interface Props {
  children: ReactNode
}
// 提供全局上下文，包含查询和主题等
const Providers = ({ children }: Props) => {
  useEffect(() => {
    // 客户端挂载后恢复缓存；已有状态不因 Strict Mode 或重复挂载再次读取。
    const persistence = useChatUiStore.persist
    if (persistence && !persistence.hasHydrated()) {
      void persistence.rehydrate()
    }
  }, [])
  return (
    <QueryProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <TooltipProvider>
          {children}
          <Toaster position="top-center" duration={3000} richColors />
        </TooltipProvider>
      </ThemeProvider>
    </QueryProvider>
  )
}

export default Providers
