import React from "react"
import { RemixiconComponentType } from "@remixicon/react"
import { usePathname, useRouter } from "next/navigation"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar"

type Menu = {
  title: string
  url: string
  icon: RemixiconComponentType
}
function NavMenu({ menus }: { menus: Menu[] }) {
  const router = useRouter()
  const pathname = usePathname()

  return (
    <>
      <SidebarMenu>
        {menus?.map((menu) => {
          // 判断当前路径是否与菜单项的 URL 匹配，以确定是否为选中状态
          const isActive = pathname === menu.url
          return (
            <SidebarMenuItem
              key={menu.title}
              className="relative flex flex-col items-stretch"
            >
              <SidebarMenuButton
                className="group/menu-button h-9 cursor-pointer rounded-md bg-linear-to-r font-medium hover:bg-transparent hover:from-sidebar-accent hover:to-sidebar-accent/40 data-[active=true]:from-primary/20 data-[active=true]:to-primary/5 [&>svg]:size-auto"
                // 选中状态
                isActive={isActive}
                onClick={() => router.push(menu.url)}
              >
                <menu.icon
                  className="text-muted-foreground/60 group-data-[active=true]/menu-button:text-primary"
                  size={22}
                />
                <span>{menu.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </>
  )
}

export default NavMenu
