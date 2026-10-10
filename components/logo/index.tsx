import React from "react"
import Link from "next/link"
import Image from "next/image"
const Logo = (props: { url?: string }) => {
  const { url = "/" } = props
  return (
    <Link
      href={url}
      aria-label="Wave AI 首页"
      className="flex w-fit items-center gap-2 group-data-[collapsible=icon]:justify-center"
    >
      <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-md bg-primary text-primary-foreground">
        <Image src="/logo.png" width={36} height={36} alt="Wave-ai" />
      </div>

      <div className="flex-1 text-left text-base leading-tight group-data-[collapsible=icon]:hidden">
        <span className="font-medium">Wave AI</span>
      </div>
    </Link>
  )
}

export default Logo
