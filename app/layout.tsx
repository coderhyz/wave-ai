import type { Metadata } from "next"
import { Geist } from "next/font/google"
import "./globals.css"
import Providers from "@/context/providers"
// 字体配置
const geist = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
})
// 页面元数据
export const metadata: Metadata = {
  title: "Wave AI · 你的智能知识助手",
  description:
    "集 AI 对话、个人知识库与深度研究于一体，帮助你整理资料、检索信息并追溯引用来源。",
}
// 根布局
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geist.variable} ${geist.className} font-sans antialiased`}
      >
        {/* 查询 主题 provider */}
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
