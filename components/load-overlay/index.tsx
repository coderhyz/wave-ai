import { RiLoader5Fill } from "@remixicon/react"
import React from "react"

type Props = {
  show: boolean
  text?: string
}

const LoaderOverlay = ({ show, text = "正在创建笔记..." }: Props) => {
  if (!show) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-xs">
      <div className="flex flex-col items-center gap-2">
        <RiLoader5Fill className="h-16 w-16 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  )
}

export default LoaderOverlay
