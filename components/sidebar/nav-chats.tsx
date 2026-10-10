"use client"

import { usePathname, useSearchParams } from "next/navigation"
import { ChatSidebarItem } from "@/components/sidebar/chat-sidebar-item"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { useChatList } from "@/hooks/use-chat-list"

/** 侧边栏中的 AI 历史会话列表。 */
export default function NavChats() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activeChatId = searchParams.get("chatId")
  // 请求历史会话列表
  const { data, isLoading, isError } = useChatList()
  const chats = data?.items ?? []

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroup className="px-0">
        <SidebarGroupLabel className="text-sm font-semibold">
          对话
        </SidebarGroupLabel>
        {/* <SidebarGroupAction
          aria-label="新建 AI 对话"
          className="mt-0.5 size-6 cursor-pointer rounded-md border bg-primary/15 hover:bg-primary/25"
          onClick={() => router.push("/chat")}
        >
          <Plus className="size-4.5" />
        </SidebarGroupAction> */}
      </SidebarGroup>

      <SidebarGroupContent className="h-auto max-h-[calc(100dvh-22rem)] min-h-32 w-full overflow-y-auto pr-0.5">
        <SidebarMenu className="gap-1.5">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, index) => (
              <SidebarMenuItem key={index}>
                {/* 骨架屏 */}
                <SidebarMenuSkeleton className="h-14" showIcon />
              </SidebarMenuItem>
            ))
          ) : isError ? (
            <li className="px-2 py-3 text-sm text-muted-foreground">
              对话列表加载失败。
            </li>
          ) : chats.length === 0 ? (
            <li className="px-2 py-3 text-sm leading-6 text-muted-foreground">
              还没有对话，开始聊一聊吧。
            </li>
          ) : (
            chats.map((chat) => (
              <ChatSidebarItem
                chat={chat}
                isActive={pathname === "/chat" && activeChatId === chat.id}
                key={chat.id}
              />
            ))
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
