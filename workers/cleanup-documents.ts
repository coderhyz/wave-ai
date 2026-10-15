/** 一次性执行保留的资源清理记录；不常驻、不轮询。 */
import prisma from "@/lib/prisma"
import { cleanupKnowledgeResources } from "@/lib/knowledge/documents/cleanup"

try {
  const result = await cleanupKnowledgeResources()
  console.log(
    `资源清理结束：成功 ${result.completed} 项，失败 ${result.failed} 项，暂未执行 ${result.pending} 项。`
  )
  if (result.failed || result.pending) process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
