"use client"
import { useTheme } from "next-themes"
import React from "react"
import Image from "next/image"
// 应用预览组件
const AppPreview = () => {
  const { theme } = useTheme()
  const isDark = theme === "dark" ? true : false
  return (
    <section className="-mt-10">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border bg-white shadow-md dark:bg-background">
        <div className="relative z-10 mx-auto max-w-5xl">
          <div className="w-full">
            <div className="relative mx-auto overflow-hidden rounded-(--radius) border border-transparent bg-background shadow-xl ring-1 shadow-black/10 ring-black/10">
              <Image
                src={
                  isDark
                    ? "/images/wave_app-dark.png"
                    : "/images/wave_app-light.png"
                }
                alt="app screen"
                width="2880"
                height="1842"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export default AppPreview
