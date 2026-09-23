"use client"

import React from "react"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "../ui/sidebar"
import { RiAddLine, RiFileTextLine } from "@remixicon/react"
import { useCreateNote, useNotes } from "@/hooks/use-note"
import useNoteId from "@/hooks/use-note-id"

function NavNotesContent() {
  const { data, isLoading, isError } = useNotes()
  // 获取当前选中的笔记ID和设置笔记ID的函数
  const { setNoteId, noteId } = useNoteId()
  const { mutate, isPending } = useCreateNote()
  const notes = data?.notes ?? []

  if (isLoading) {
    return <NavNotesFallback />
  }

  const onCreate = () => {
    if (isPending) return
    // 创建笔记参数
    mutate({
      title: "Untitled",
      content: "",
    })
  }

  return (
    <SidebarGroup>
      <SidebarGroup className="px-0">
        <SidebarGroupLabel>
          <h5>笔记</h5>
        </SidebarGroupLabel>

        <SidebarGroupAction
          className="mt-[1.5px] flex size-5.5 cursor-pointer items-center rounded-md border bg-primary/20 disabled:pointer-events-none disabled:opacity-50"
          onClick={onCreate}
          aria-disabled={isPending}
        >
          <RiAddLine className="size-5!" />
          <span className="sr-only">创建笔记</span>
        </SidebarGroupAction>
      </SidebarGroup>

      <SidebarGroupContent className="h-auto max-h-90 min-h-32 w-full overflow-y-auto">
        <SidebarMenu>
          {isError ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">
              Failed to load notes.
            </div>
          ) : notes.length === 0 ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">
              还没有笔记，请创建。
            </div>
          ) : (
            notes.map((note) => {
              const isActive = note.id === noteId
              return (
                // let isActive = note.id === noteId;
                // 笔记部分
                <SidebarMenuItem key={note.id}>
                  <SidebarMenuButton
                    isActive={isActive}
                    className="flex w-full items-center"
                    onClick={() => setNoteId(note.id)}
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
                      <RiFileTextLine className="h-4 w-4 text-primary" />
                    </span>
                    <h5 className="flex-1 truncate">{note.title}</h5>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function NavNotesFallback() {
  return (
    <SidebarGroup>
      <SidebarGroup className="px-0">
        <SidebarGroupLabel>
          <h5>笔记</h5>
        </SidebarGroupLabel>
      </SidebarGroup>

      <SidebarGroupContent className="h-auto max-h-90 min-h-32 w-full overflow-y-auto">
        <SidebarMenu>
          {Array.from({ length: 4 }).map((_, index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
//加载骨架屏
export default function NavNotes() {
  return <NavNotesContent />
}
