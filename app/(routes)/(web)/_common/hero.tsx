import React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { RiExternalLinkLine } from "@remixicon/react"

const Hero = () => {
  return (
    <section
      className={cn(
        "relative mt-6 overflow-hidden rounded-3xl border shadow-sm",
        "px-6 py-14 sm:py-16 md:py-18"
      )}
    >
      <div className="relative z-10 mx-auto max-w-3xl text-center">
        {/* Badges */}
        <div className="mb-5 flex items-center justify-center gap-2">
          <span className="rounded-full border border-white/20 bg-white px-3 py-1 text-xs font-medium shadow-lg backdrop-blur-md dark:bg-black/40 dark:text-white">
            AI 对话 · 个人知识库 · 深度研究
          </span>
        </div>

        <h1
          className={cn(
            `fade-in-up relative -ml-2 bg-gradient-to-r from-black to-black bg-clip-text text-4xl leading-tight font-extrabold tracking-tight text-balance text-transparent opacity-0 transition-colors duration-500 [animation-delay:200ms] text-shadow-xs sm:text-5xl md:text-6xl dark:from-white dark:to-white dark:text-shadow-none`
          )}
        >
          <span className="block">连接你的知识</span>
          <span className="fade-in-down mt-2 block">探索更深的答案</span>
        </h1>

        <p className="fade-in-up mt-4 text-base leading-relaxed text-pretty text-muted-foreground opacity-0 [animation-delay:200ms] sm:text-lg">
          与 AI 自然对话，上传文档构建个人知识库，结合网页检索开展深度研究。
          从整理资料到追溯引用，让知识成为思考的助力。
        </p>

        <div className="mt-8 flex items-center justify-center gap-4">
          <Button
            asChild
            className={cn(
              "rounded-full px-6 py-5 !pl-8 text-sm shadow-lg sm:py-6 sm:!text-base",
              "bg-black text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/90"
            )}
          >
            <Link href="/auth/sign-in" className="">
              开始使用
              <RiExternalLinkLine className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  )
}

export default Hero
