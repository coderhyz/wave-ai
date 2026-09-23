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
import { ChevronsUpDownIcon } from "lucide-react"

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
  const { isMobile } = useSidebar()

  return (
    // 导航栏菜单
    <SidebarMenu>
      {/* 菜单项 */}
      <SidebarMenuItem>
        <DropdownMenu>
          {isLoading ? (
            <RiLoader5Fill className="h-5 w-5 animate-spin text-center" />
          ) : (
            // 下拉菜单触发项
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar className="h-8 w-8 rounded-lg border border-primary">
                  <AvatarFallback className="rounded-lg">
                    {user?.name?.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div className="text-left text-sm leading-tight">
                  <span className="block truncate font-medium">
                    {user?.name}
                  </span>
                  <span className="block truncate font-medium">
                    {user?.email}
                  </span>
                </div>
                <ChevronsUpDownIcon className="size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
          )}
          {/* 下拉菜单内容 */}
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            // 出现的位置
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={12}
            onCloseAutoFocus={(e) => {
              if (isSigningOut) {
                e.preventDefault()
              }
            }}
          >
            {/* 用户信息 */}
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg border border-primary">
                  <AvatarFallback className="rounded-lg">
                    {user?.name?.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div className="text-left text-sm leading-tight">
                  <span className="block truncate font-medium">
                    {user?.name}
                  </span>
                  <span className="block truncate font-medium">
                    {user?.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* 触发的菜单项 */}
            <DropdownMenuItem
              className="relative"
              disabled={isSigningOut}
              onClick={onSignOut}
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
