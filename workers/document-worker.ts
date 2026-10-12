/**
 * 独立知识库文档 Worker。
 * 持续领取一条待处理任务；队列空闲时短暂等待，收到退出信号后安全停止。
 */
import { processNextDocumentJob } from "@/lib/knowledge/jobs/processor"

let stopping = false
/** SIGINT/SIGTERM 只设置停止标记，让当前任务有机会正常完成。 */
const stop = () => {
  stopping = true
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

/** 队列空闲或发生临时异常时使用的非阻塞等待。 */
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

console.log("Document worker started")
while (!stopping) {
  try {
    // 每轮最多处理一个任务，避免一次调用长时间占用事件循环。
    const processed = await processNextDocumentJob()
    if (!processed) await wait(1_000)
  } catch (error) {
    console.error("Document worker loop failed", error)
    await wait(2_000)
  }
}
console.log("Document worker stopped")
