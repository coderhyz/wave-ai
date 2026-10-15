/** 为已有 READY 正文直接重建两路索引；命令完成即表示实际处理结束。 */
import prisma from "@/lib/prisma"
import { indexKnowledgeDocument } from "@/lib/knowledge/documents/process-document"
import { KnowledgeError } from "@/lib/knowledge/errors"

const controller = new AbortController()
const stop = () =>
  controller.abort(new DOMException("索引重建已中止", "AbortError"))
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

try {
  controller.signal.throwIfAborted()
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      deletedAt: null,
      status: "READY",
      markdownContent: { not: null },
      knowledgeBase: { deletedAt: null },
    },
    select: {
      id: true,
      contentRevision: true,
      knowledgeBase: { select: { userId: true } },
    },
  })
  let completed = 0
  let skipped = 0
  let failed = 0
  for (const document of documents) {
    controller.signal.throwIfAborted()
    try {
      await indexKnowledgeDocument({
        userId: document.knowledgeBase.userId,
        documentId: document.id,
        contentRevision: document.contentRevision,
        signal: controller.signal,
      })
      completed++
    } catch (error) {
      controller.signal.throwIfAborted()
      if (
        error instanceof KnowledgeError &&
        (error.status === 404 || error.status === 409)
      ) {
        skipped++
        console.warn(`跳过文档 ${document.id}：${error.message}`)
      } else {
        failed++
        console.error(`文档 ${document.id} 索引重建失败`, error)
      }
    }
  }
  console.log(
    `索引重建结束：成功 ${completed} 篇，跳过 ${skipped} 篇，失败 ${failed} 篇。`
  )
  if (failed > 0) process.exitCode = 1
} finally {
  process.removeListener("SIGINT", stop)
  process.removeListener("SIGTERM", stop)
  await prisma.$disconnect()
}
