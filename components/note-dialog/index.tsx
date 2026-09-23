"use client"
import React from "react"
import useNoteId from "@/hooks/use-note-id"
import { XIcon } from "lucide-react"
import { Button } from "../ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet"
import NoteView from "./note-view"

function NoteDialog() {
  const { noteId, clearNoteId } = useNoteId()
  const isOpen = Boolean(noteId)

  // 处理侧边栏打开状态变化的函数
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      clearNoteId()
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-transparent backdrop-blur-0"
        // onInteractOutside={(event) => event.preventDefault()}
        className="gap-0 border-l p-0 shadow-2xl duration-300 ease-out data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:data-closed:slide-out-to-right-full data-[side=right]:data-open:slide-in-from-right-full data-[side=right]:sm:w-[50vw] data-[side=right]:sm:max-w-none data-[side=right]:lg:w-1/2"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>没有内容</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 笔记内容 */}
          {noteId && <NoteView noteId={noteId} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default NoteDialog
