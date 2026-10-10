"use client"

import dynamic from "next/dynamic"
import useNoteId from "@/hooks/use-note-id"
import { LoaderCircle } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet"

/** 富文本编辑器体积较大，只在用户真正打开笔记时下载。 */
const NoteView = dynamic(() => import("./note-view"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
      正在加载笔记…
    </div>
  ),
})

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
