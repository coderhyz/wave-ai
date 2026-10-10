
import Header from "@/app/(routes)/(dashboard)/_common/header"
function MainSection() {
  return (
    <div className="relative min-h-0 w-full items-center justify-center">
      {/* Header */}
      <Header />

      {/* 聊天部分 */}
      {/* 笔记部分 */}
      <div className="mt-7 w-full">
        <h2 className="text-sm dark:text-gray-300">这里是笔记部分</h2>
      </div>
    </div>
  )
}

export default MainSection
