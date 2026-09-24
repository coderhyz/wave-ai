"use client"

import React from "react"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import ModeToggle from "@/components/mode-toggle"
// import { useLocalChat } from "@/hooks/use-localchat";

type HeaderProps = {
  title?: string
  showActions?: boolean
}

function Header({ title, showActions = true }: HeaderProps) {
  // 侧边栏状态
  const { open, isMobile } = useSidebar()
  return (
    <header className="fixed inset-0 top-0 z-9 flex h-13 items-center bg-background/20 px-2 py-1 backdrop-blur-sm">
      {(!open || isMobile) && <SidebarTrigger className="h-10" />}
      {!showActions && title && (
        <div
          className={cn(
            "flex w-full items-center justify-between pt-5",
            open && "w-full max-w-full! lg:p-[10px_0_0_250px]"
          )}
        >
          <h2 className="text-xl font-semibold lg:text-2xl">{title}</h2>
          <ModeToggle className="size-9 shrink-0 rounded-lg border-border/70 bg-background/80 shadow-xs backdrop-blur-sm" />
        </div>
      )}

      {showActions && (
        <div
          className={cn(
            "flex w-full items-center justify-between",
            open && "! w-full max-w-full! lg:p-[0_0_0_250px]"
          )}
        >
          <h2 className="text-xl font-semibold lg:text-2xl">{title}</h2>
          <ModeToggle className="ml-auto size-9 shrink-0 rounded-lg border-border/70 bg-background/80 shadow-xs backdrop-blur-sm" />
        </div>
      )}
    </header>
  )
}

export default Header
