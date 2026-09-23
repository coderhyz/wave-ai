"use client"

import { FormEvent, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Ellipsis,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  type ChatListItem,
  useDeleteChat,
  useUpdateChat,
} from "@/hooks/use-chat-list"

interface ChatSidebarItemProps {
  chat: ChatListItem
  isActive: boolean
}

/** 渲染单条历史会话，并处理重命名、置顶和删除操作。 */
export function ChatSidebarItem({ chat, isActive }: ChatSidebarItemProps) {
  const router = useRouter()
  const updateChat = useUpdateChat()
  const deleteChat = useDeleteChat()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [title, setTitle] = useState(chat.title)

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextTitle = title.trim()

    if (!nextTitle || nextTitle === chat.title) {
      setRenameOpen(false)
      return
    }

    try {
      await updateChat.mutateAsync({ id: chat.id, title: nextTitle })
      setRenameOpen(false)
      toast.success("对话已重命名")
    } catch {
      // 错误提示由 mutation 统一处理。
    }
  }

  const handleTogglePin = async () => {
    try {
      await updateChat.mutateAsync({
        id: chat.id,
        isPinned: !chat.isPinned,
      })
      toast.success(chat.isPinned ? "已取消置顶" : "对话已置顶")
    } catch {
      // 错误提示由 mutation 统一处理。
    }
  }

  const handleDelete = async () => {
    try {
      await deleteChat.mutateAsync(chat.id)
      setDeleteOpen(false)
      toast.success("对话已删除")

      if (isActive) {
        router.push("/chat")
      }
    } catch {
      // 错误提示由 mutation 统一处理。
    }
  }

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-12 gap-2.5 rounded-xl px-2.5 text-[15px]"
          isActive={isActive}
          onClick={() => router.push(`/chat?chatId=${chat.id}`)}
          tooltip={chat.title}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <MessageCircle className="size-[18px] text-primary" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {chat.title}
          </span>
          {chat.isPinned && <Pin className="size-3.5 text-muted-foreground" />}
        </SidebarMenuButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction
              aria-label={`${chat.title}的更多操作`}
              className="top-3 right-2 size-6 cursor-pointer rounded-md"
              showOnHover
            >
              <Ellipsis className="size-[18px]" />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-48 rounded-xl p-1.5"
            side="right"
            sideOffset={16}
          >
            <DropdownMenuItem
              className="h-10 cursor-pointer rounded-lg px-3 text-sm"
              onSelect={() => {
                setTitle(chat.title)
                setRenameOpen(true)
              }}
            >
              <Pencil className="size-4.5" />
              重命名对话
            </DropdownMenuItem>
            <DropdownMenuItem
              className="h-10 cursor-pointer rounded-lg px-3 text-sm"
              disabled={updateChat.isPending}
              onSelect={handleTogglePin}
            >
              {chat.isPinned ? (
                <PinOff className="size-4.5" />
              ) : (
                <Pin className="size-4.5" />
              )}
              {chat.isPinned ? "取消置顶" : "置顶对话"}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-1.5" />
            <DropdownMenuItem
              className="h-10 cursor-pointer rounded-lg px-3 text-sm"
              onSelect={() => setDeleteOpen(true)}
              variant="destructive"
            >
              <Trash2 className="size-4.5" />
              删除对话
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <form className="grid gap-6" onSubmit={handleRename}>
            <DialogHeader>
              <DialogTitle>重命名对话</DialogTitle>
              <DialogDescription>
                修改后的标题会同步显示在历史会话列表中。
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              value={title}
            />
            <DialogFooter>
              <Button
                onClick={() => setRenameOpen(false)}
                type="button"
                variant="outline"
              >
                取消
              </Button>
              <Button
                disabled={!title.trim() || updateChat.isPending}
                type="submit"
              >
                {updateChat.isPending ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除对话</DialogTitle>
            <DialogDescription>
              “{chat.title}”及其中的全部消息会被永久删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setDeleteOpen(false)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={deleteChat.isPending}
              onClick={handleDelete}
              type="button"
              variant="destructive"
            >
              {deleteChat.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
