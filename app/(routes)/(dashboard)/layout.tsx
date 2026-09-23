import { Suspense } from "react"
import { RiLoader5Fill } from "@remixicon/react"
import { NuqsAdapter } from "nuqs/adapters/next/app"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import AppSidebar from "@/components/sidebar/index" // path to your sidebar component
import { auth } from "@/lib/auth" // path to your Better Auth server instance
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import MainContent from "./_common/main-content" // path to your main content component
import NoteDialog from "@/components/note-dialog"
async function DashBoardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(), // you need to pass the headers object.
  })
  if (!session) {
    // 如果没有 session，重定向到登录页
    redirect("/auth/sign-in")
  }
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <RiLoader5Fill className="h-16 w-16 animate-spin text-primary" />
        </div>
      }
    >
      <NuqsAdapter>
        <SidebarProvider>
          {/* 导航栏 */}
          <AppSidebar />
          {/* Content */}
          <SidebarInset className="relative overflow-x-hidden pt-0">
            {/* 主要内容 */}
            <MainContent>{children}</MainContent>
            <NoteDialog />
          </SidebarInset>
        </SidebarProvider>
      </NuqsAdapter>
    </Suspense>
  )
}

export default DashBoardLayout
