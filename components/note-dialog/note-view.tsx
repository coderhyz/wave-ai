"use client"
import React, { useEffect, useRef, useState } from "react"
import { useNote, useUpdateNote } from "@/hooks/use-note"
import { RiLoader5Fill } from "@remixicon/react"
import { AutosizeTextarea, AutosizeTextAreaRef } from "../ui/autosize-textarea"
import { Button } from "../ui/button"

const NoteView = ({ noteId }: { noteId: string }) => {
  const [title, setTitle] = useState<string>("")
  const [content, setContent] = useState<string>("")

  const titleTextareaRef = useRef<AutosizeTextAreaRef | null>(null)
  const contentTextareaRef = useRef<AutosizeTextAreaRef | null>(null)
  // 根据id获取笔记数据
  const { data, isPending: isLoading } = useNote(noteId)
  // 更新笔记数据
  const { mutate, isPending } = useUpdateNote()

  const note = data?.data

  useEffect(() => {
    if (note) {
      setTitle(note.title)
      setContent(note.content)
    }
  }, [note])

  useEffect(() => {
    if (!isLoading) {
      // 自动聚焦标题输入框
      const titleTextAreaEle = titleTextareaRef.current
      if (titleTextAreaEle) {
        titleTextAreaEle.textArea.style.minHeight = "auto !important"
        titleTextAreaEle.textArea.style.maxHeight = "auto !important"
        titleTextAreaEle.textArea.focus()
      }
    }
  }, [isLoading])

  const handleUpdate = () => {
    if (!noteId) return
    // 更新的数据
    mutate({
      id: noteId,
      json: {
        title: title,
        content: content,
      },
    })
  }
  // 自动聚焦标题输入框
  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      contentTextareaRef.current?.textArea.focus()
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-[20vh] w-full items-center justify-center">
        <RiLoader5Fill className="h-16 w-16 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="relative h-full w-full p-6">
      <div className="mb-3 w-full pl-2">
        {/* 组件 */}
        <div className="border-b">
          <AutosizeTextarea
            ref={titleTextareaRef}
            value={title}
            onKeyDown={handleTitleKeyDown}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="笔记标题"
            className="w-full resize-none overflow-hidden border-none! bg-transparent px-0! text-4xl leading-tight font-bold outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0! focus-visible:ring-offset-0!"
          />
        </div>
      </div>

      <div className="w-full pl-2">
        <AutosizeTextarea
          ref={contentTextareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="开始写作..."
          className="! min-h-[65vh]! w-full resize-none border-none! bg-transparent px-0 text-base leading-relaxed outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0! focus-visible:ring-offset-0!"
        />
      </div>

      <div className="sticky bottom-0 z-50 flex justify-end bg-background py-2">
        <Button
          onClick={handleUpdate}
          disabled={isPending || !noteId || !content}
          className="cursor-pointer rounded-full px-10 text-lg disabled:opacity-75"
          size="lg"
        >
          {isPending && <RiLoader5Fill className="h-7 w-7 animate-spin" />}
          保存笔记
        </Button>
      </div>
    </div>
  )
}

export default NoteView
