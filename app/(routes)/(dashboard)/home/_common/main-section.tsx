import { RiEmotionHappyFill } from "@remixicon/react"
import Header from "@/app/(routes)/(dashboard)/_common/header"
function MainSection() {
  return (
    <div className="relative min-h-0 w-full items-center justify-center">
      {/* Header */}
      <Header />
      <div className="mt-16 flex w-full items-center justify-center px-4 py-4">
        <h1 className="fade-in-up z-0 flex items-center gap-2 text-center text-[24px] font-semibold tracking-tighter text-pretty text-gray-800 opacity-0 [animation-delay:200ms] sm:text-[30px] md:text-[35px] dark:text-white">
          <RiEmotionHappyFill className="size-6! md:size-10! lg:mt-2" />
          你好，有什么能帮你的吗？
        </h1>
      </div>
      {/* 聊天部分 */}
      {/* 笔记部分 */}
      <div className="mt-7 w-full">
        <h2 className="text-sm dark:text-gray-300">这里是笔记部分</h2>
      </div>
    </div>
  )
}

export default MainSection
