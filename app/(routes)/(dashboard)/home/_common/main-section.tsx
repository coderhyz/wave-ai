import { RiEmotionHappyFill } from "@remixicon/react";
import Header from "@/app/(routes)/(dashboard)/_common/header";
function MainSection() {
    return (

        <div className="relative min-h-0 w-full justify-center items-center">
            {/* Header */}
            <Header />
            <div className="w-full px-4 py-4 flex items-center justify-center mt-16">
                <h1
                    className="flex items-center gap-2 font-semibold text-pretty text-center
                tracking-tighter text-gray-800 dark:text-white sm:text-[30px]
                md:text-[35px] text-[24px]
                opacity-0 fade-in-up [animation-delay:200ms] z-0">
                    <RiEmotionHappyFill className="size-6! md:size-10! lg:mt-2" />
                    你好，有什么能帮你的吗？
                </h1>
            </div>
            {/* 聊天部分 */}
            {/* 笔记部分 */}
            <div className="w-full pt-7 ">
                <h2 className="text-sm  dark:text-gray-300">
                    这里是笔记部分
                </h2>
            </div>
        </div >
    );
}

export default MainSection;
