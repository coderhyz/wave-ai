"use client"
import { RiChatAiLine, RiSettings3Line } from "@remixicon/react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "../ui/sidebar"
import Logo from "@/components/logo/index" // path to your logo component
import { useState } from "react"
import { useRouter } from "next/navigation"
import { useAuthToken } from "@/hooks/use-auth-token"
import { authClient } from "@/lib/auth-client"
import { toast } from "sonner"
import NavMenu from "@/components/sidebar/nav-menu"
import NavUser from "@/components/sidebar/nav-user"
import NavChats from "@/components/sidebar/nav-chats"
import { BookText } from "lucide-react"
// 菜单项
const navMenu = [
  {
    title: "AI对话",
    url: "/chat",
    icon: RiChatAiLine,
  },
  {
    title: "知识库",
    url: "/home",
    icon: BookText,
  },

  {
    title: "设置",
    url: "/settings",
    icon: RiSettings3Line,
  },
]
// 侧边栏组件
function AppSidebar({
  collapsible = "icon",
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter()
  // 清除认证令牌的函数
  const { clearBearerToken } = useAuthToken()
  // 退出登录状态
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false)
  // Better Auth 认证客户端 Hook
  const { useSession, signOut } = authClient
  const { data: session, isPending: isLoading } = useSession()
  // 用户信息
  const user = session?.user
  // 用户信息
  const userInfo = {
    name: user?.name || "",
    email: user?.email || "",
  }
  // 退出登录处理函数
  const handleLogout = () => {
    if (isSigningOut) return
    setIsSigningOut(true)
    // 退出登录
    signOut({
      fetchOptions: {
        onSuccess: () => {
          // 退出登录成功后，清除认证令牌并重定向到登录页
          clearBearerToken()
          router.push("/auth/sign-in")
          setIsSigningOut(false)
        },
        onError: (ctx) => {
          setIsSigningOut(false)
          toast.error(ctx.error.message)
        },
      },
    })
  }

  return (
    <>
      {/* <NoteDialog /> */}
      <Sidebar collapsible={collapsible} className="z-99" {...props}>
        {/* 导航栏头部 */}
        <SidebarHeader>
          <div className="flex w-full items-center justify-between">
            <Logo url="/home" />
            <SidebarTrigger className="-ms-4 group-data-[collapsible=icon]:hidden" />
          </div>
          {/* 分割线 */}
          <hr className="mx-2 -mt-px border-border" />
          {/* {Search Button} */}
        </SidebarHeader>
        {/* 导航栏内容 */}
        <SidebarContent className="overflow-x-hidden px-2 pt-2">
          {/* 导航菜单 */}
          <NavMenu menus={navMenu} />
          {/* AI 对话列表；笔记列表暂时不显示。 */}
          <NavChats />
        </SidebarContent>
        {/* 导航栏底部 */}
        <SidebarFooter>
          <hr className="mx-2 -mt-px border-border" />
          {/* 底部用户信息栏 */}
          <NavUser
            isLoading={isLoading}
            user={userInfo}
            isSigningOut={isSigningOut}
            onSignOut={handleLogout}
          />
        </SidebarFooter>
      </Sidebar>
    </>
  )
}

export default AppSidebar
