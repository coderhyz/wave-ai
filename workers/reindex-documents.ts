/** 为已有 READY 正文补建两路索引，只登记任务；实际处理仍由 document-worker 完成。 */
import prisma from "@/lib/prisma"
import { ensureKnowledgeChunkIndex } from "@/lib/es/knowledge-index"
import { lockOwnedKnowledgeBase } from "@/lib/knowledge/ownership"
import { registerRechunkJob } from "@/lib/knowledge/management/service"

try {
  await ensureKnowledgeChunkIndex()
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      deletedAt: null,
      status: "READY",
      markdownContent: { not: null },
      knowledgeBase: { deletedAt: null },
    },
    select: {
      id: true,
      knowledgeBaseId: true,
      knowledgeBase: { select: { userId: true } },
    },
  })
  let queued = 0
  for (const document of documents) {
    queued += await prisma.$transaction(async (db) => {
      await lockOwnedKnowledgeBase(
        db,
        document.knowledgeBase.userId,
        document.knowledgeBaseId
      )
      const current = await db.knowledgeDocument.findFirst({
        where: { id: document.id, deletedAt: null, status: "READY" },
        select: { id: true, knowledgeBaseId: true, contentRevision: true },
      })
      if (!current) return 0
      await registerRechunkJob(db, current)
      // 相同正文版本可能早已索引成功，复用原任务，而不是被 dedupeKey 跳过。
      const scheduled = await db.documentProcessingJob.updateMany({
        where: {
          dedupeKey: `rechunk:${current.id}:${current.contentRevision}`,
          status: { in: ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] },
        },
        data: {
          status: "PENDING",
          attempts: 0,
          availableAt: new Date(),
          lastError: null,
          lockToken: null,
          lockedAt: null,
          lockedUntil: null,
        },
      })
      // 已运行的同版本任务继续完成，不清除它的租约或重置进度。
      if (scheduled.count !== 1) return 0
      await db.knowledgeDocument.updateMany({
        where: { id: current.id, contentRevision: current.contentRevision },
        data: { chunkStatus: "PENDING", chunkErrorMessage: null },
      })
      return 1
    }, {
      isolationLevel: "ReadCommitted",
      maxWait: 5_000,
      // 与 Worker 保持一致，容纳远端数据库的锁检查和多次往返。
      timeout: 30_000,
    })
  }
  console.log(
    `已登记 ${queued} 篇文档的索引任务，请保持 document-worker 运行。`
  )
} finally {
  await prisma.$disconnect()
}
