import React from "react"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { RiLoader5Fill, RiLogoutBoxLine } from "@remixicon/react"
import { Avatar, AvatarFallback } from "../ui/avatar"
import { ChevronsUpDownIcon, Settings2Icon } from "lucide-react"
import { useRouter } from "next/navigation"

type NavUserProps = {
  isLoading: boolean
  isSigningOut: boolean
  user: {
    name: string
    email: string
  }
  onSignOut: () => void
}
// 用户导航组件
function NavUser({ user, isLoading, isSigningOut, onSignOut }: NavUserProps) {
  // 获取侧边栏状态，判断是否为移动端
  const { isMobile, state } = useSidebar()
  const router = useRouter()
  const userInitial = user.name?.charAt(0) || user.email?.charAt(0) || "U"

  return (
    // 导航栏菜单
    <SidebarMenu>
      {/* 菜单项 */}
      <SidebarMenuItem>
        <DropdownMenu>
          {isLoading ? (
            <div className="flex h-10 items-center justify-center">
              <RiLoader5Fill className="size-5 animate-spin" />
            </div>
          ) : (
            // 下拉菜单触发项
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                aria-label="打开账户菜单"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center"
              >
                <Avatar className="size-8 rounded-full border border-primary/70">
                  <AvatarFallback className="rounded-full">
                    {userInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="block truncate font-medium">
                    {user?.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {user?.email}
                  </span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
          )}
          {/* 下拉菜单内容 */}
          <DropdownMenuContent
            className="w-72 min-w-72 rounded-xl p-1.5 shadow-xl"
            // 出现的位置
            side={isMobile ? "bottom" : "right"}
            align={state === "collapsed" ? "end" : "start"}
            sideOffset={8}
            onCloseAutoFocus={(e) => {
              if (isSigningOut) {
                e.preventDefault()
              }
            }}
          >
            {/* 用户信息 */}
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-3 px-2 py-2 text-left text-sm">
                <Avatar className="size-10 rounded-full border border-primary/70">
                  <AvatarFallback className="rounded-full">
                    {userInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="block truncate font-medium">
                    {user?.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {user?.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="h-10 cursor-pointer rounded-lg"
              onSelect={() => router.push("/settings")}
            >
              <Settings2Icon className="text-muted-foreground" />
              账号设置
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* 触发的菜单项 */}
            <DropdownMenuItem
              className="relative h-10 cursor-pointer rounded-lg"
              disabled={isSigningOut}
              onSelect={onSignOut}
            >
              {/* 退出登录图标 */}
              <RiLogoutBoxLine className="text-muted-foreground/60" />
              退出登录
              {isSigningOut && (
                <RiLoader5Fill className="absolute right-2 h-4 w-4 animate-spin" />
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export default NavUser
