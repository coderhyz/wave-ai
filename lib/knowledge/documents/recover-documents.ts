import "server-only"

import type { Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import { DOCUMENT_PROCESSING_TIMEOUT_MS } from "./timeouts"

/** 仅供停服后的维护命令调用；不自动重试解析，不改正文、版本或清理记录。 */
export async function recoverInterruptedDocuments() {
  const result = { recovered: 0, retired: 0, pending: 0 }
  const candidates = await prisma.knowledgeDocument.findMany({
    where: {
      OR: [
        { status: { in: ["QUEUED", "PARSING"] } },
        { chunkStatus: "RUNNING" },
        { status: "READY", chunkStatus: "PENDING" },
        { jobs: { some: { type: { not: "CLEANUP" } } } },
      ],
    },
    select: { id: true, knowledgeBaseId: true },
  })
  for (const candidate of candidates) {
    const outcome = await prisma.$transaction(
      async (db) => {
        await db.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${candidate.knowledgeBaseId}, 0))::text
      `
        const document = await db.knowledgeDocument.findFirst({
          where: {
            id: candidate.id,
            knowledgeBaseId: candidate.knowledgeBaseId,
          },
          select: {
            id: true,
            status: true,
            chunkStatus: true,
            contentRevision: true,
            updatedAt: true,
          },
        })
        if (!document) return { recovered: 0, retired: 0, pending: 0 }
        const jobs = await db.documentProcessingJob.findMany({
          where: { documentId: document.id, type: { not: "CLEANUP" } },
          select: { status: true, lockedUntil: true },
        })
        const parsing =
          document.status === "QUEUED" || document.status === "PARSING"
        const indexing =
          document.chunkStatus === "RUNNING" ||
          (document.status === "READY" && document.chunkStatus === "PENDING")
        const now = Date.now()
        if (
          ((parsing || indexing) &&
            document.updatedAt.getTime() >
              now - DOCUMENT_PROCESSING_TIMEOUT_MS) ||
          jobs.some(
            (job) =>
              job.status === "RUNNING" &&
              (!job.lockedUntil || job.lockedUntil.getTime() > now)
          )
        ) {
          console.warn(
            `跳过文档 ${document.id}：处理安全窗口或旧任务租约尚未结束。`
          )
          return { recovered: 0, retired: 0, pending: 1 }
        }
        if (parsing || indexing) {
          const data: Prisma.KnowledgeDocumentUpdateManyMutationInput = {
            ...(parsing
              ? {
                  status: "FAILED",
                  parseErrorCode: "PARSE_FAILED",
                  parseErrorMessage: "上次解析已中断，请重新解析文档",
                }
              : {}),
            ...(indexing
              ? {
                  chunkStatus: "FAILED",
                  chunkErrorMessage: "上次索引处理已中断，请重新建立索引",
                }
              : {}),
          }
          const updated = await db.knowledgeDocument.updateMany({
            where: {
              id: document.id,
              status: document.status,
              chunkStatus: document.chunkStatus,
              contentRevision: document.contentRevision,
              updatedAt: document.updatedAt,
            },
            data,
          })
          if (updated.count !== 1)
            return { recovered: 0, retired: 0, pending: 1 }
        }
        const retired = await db.documentProcessingJob.deleteMany({
          where: { documentId: document.id, type: { not: "CLEANUP" } },
        })
        return {
          recovered: parsing || indexing ? 1 : 0,
          retired: retired.count,
          pending: 0,
        }
      },
      { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 30_000 }
    )
    result.recovered += outcome.recovered
    result.retired += outcome.retired
    result.pending += outcome.pending
  }

  // 文档已删除的旧解析任务没有资源回收职责；CLEANUP 独立保留。
  const orphaned = await prisma.documentProcessingJob.findMany({
    where: { documentId: null, type: { not: "CLEANUP" } },
    select: { id: true, status: true, lockToken: true, lockedUntil: true },
  })
  for (const job of orphaned) {
    if (
      job.status === "RUNNING" &&
      (!job.lockedUntil || job.lockedUntil.getTime() > Date.now())
    ) {
      result.pending++
      console.warn(`跳过历史任务 ${job.id}：租约尚未结束。`)
      continue
    }
    const retired = await prisma.documentProcessingJob.deleteMany({
      where: {
        id: job.id,
        type: { not: "CLEANUP" },
        status: job.status,
        lockToken: job.lockToken,
        lockedUntil: job.lockedUntil,
      },
    })
    result.retired += retired.count
    if (retired.count !== 1) result.pending++
  }
  return result
}
