"use client"

import React, { ReactNode } from "react"
import QueryProvider from "./query-provider"
import { Toaster } from "sonner"
import { ThemeProvider } from "./theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"

interface Props {
  children: ReactNode
}
// 提供全局上下文，包含查询和主题等
const Providers = ({ children }: Props) => {
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
