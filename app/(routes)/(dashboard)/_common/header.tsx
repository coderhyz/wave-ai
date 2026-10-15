"use client"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

type HeaderProps = {
  title?: string
}

function Header({ title }: HeaderProps) {
  // 侧边栏状态
  const { open, isMobile } = useSidebar()
  return (
    <header className="fixed inset-0 top-0 z-9 flex h-13 items-center bg-background/20 px-2 py-1 backdrop-blur-sm">
      {(!open || isMobile) && (
        <SidebarTrigger
          className={cn("h-10", !isMobile && "ml-(--sidebar-width-icon)")}
        />
      )}
      <div
        className={cn(
          "flex w-full items-center justify-between",
          open && "! w-full max-w-full! lg:p-[0_0_0_250px]"
        )}
      >
        <h2 className="text-xl font-semibold lg:text-2xl">{title}</h2>
      </div>
    </header>
  )
}

export default Header
