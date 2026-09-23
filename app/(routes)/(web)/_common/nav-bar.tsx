"use client"

import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import Logo from "@/components/logo"
import { HoverBorderGradient } from "@/components/ui/hover-border-gradient"

function Navbar() {
  return (
    <header>
      <nav
        className={cn(
          "mx-auto mt-px flex items-center justify-between gap-3",
          "rounded-full border bg-white/70 px-4 py-2 shadow-sm backdrop-blur-md",
          "dark:bg-black/30"
        )}
        aria-label="Primary"
      >
        <Logo url="/" />

        <div className="flex items-center gap-2">
          <Link
            href="/auth/sign-in"
            className="hidden text-sm transition-colors hover:text-foreground md:inline"
          >
            登录
          </Link>
          <Link href="/auth/sign-up" aria-label="Try WaveAI for free">
            <HoverBorderGradient
              containerClassName="rounded-full"
              as="button"
              className="flex cursor-pointer items-center justify-center gap-2 px-4 py-2"
            >
              <span>免费 使用WaveAI</span>
              <ArrowRight className="h-4 w-4" />
            </HoverBorderGradient>
          </Link>
        </div>
      </nav>
    </header>
  )
}

export default Navbar
