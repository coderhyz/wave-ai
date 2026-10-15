/** 一次性退役旧解析任务、恢复中断状态；必须先停止 Web 和所有旧 Worker。 */
import prisma from "@/lib/prisma"
import { recoverInterruptedDocuments } from "@/lib/knowledge/documents/recover-documents"

try {
  if (process.argv.slice(2).join(" ") !== "--offline")
    throw new Error(
      "请先停止 Web 和所有旧文档 Worker，再使用 npm run recover:documents -- --offline；该命令会更新文档状态并移除旧解析任务。"
    )
  const result = await recoverInterruptedDocuments()
  console.log(
    `中断恢复结束：恢复 ${result.recovered} 篇文档，退役 ${result.retired} 条旧任务，暂未处理 ${result.pending} 项。`
  )
  if (result.pending) process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
