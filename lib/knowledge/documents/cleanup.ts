import "server-only"

import { randomUUID } from "node:crypto"
import type { Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import { deleteKnowledgeChunks } from "@/lib/es/knowledge-index"
import { deleteOssObject } from "@/lib/storage/oss"
import { DOCUMENT_PROCESSING_TIMEOUT_MS } from "@/lib/knowledge/documents/timeouts"

/** 资源清单来自持久化记录；关联文档删除后仍可独立执行。 */
async function deleteKnowledgeCleanupResource(
  payload: Prisma.JsonValue
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("文档清理记录 payload 无效")
  if (payload.target === "elasticsearch") {
    if (typeof payload.documentId !== "string" || !payload.documentId)
      throw new Error("ES 清理记录缺少 documentId")
    await deleteKnowledgeChunks(payload.documentId)
  } else {
    if (typeof payload.storageKey !== "string" || !payload.storageKey)
      throw new Error("文档清理记录缺少 storageKey")
    await deleteOssObject(payload.storageKey)
  }
}

/** 仅执行本次资源清单；无参数供一次性补偿命令使用，不启动轮询。 */
export async function cleanupKnowledgeResources(documentIds?: string[]) {
  const result = { completed: 0, failed: 0, pending: 0 }
  if (documentIds?.length === 0) return result
  const jobs = await prisma.documentProcessingJob.findMany({
    where: {
      type: "CLEANUP",
      status: { in: ["PENDING", "FAILED", "CANCELLED", "RUNNING"] },
      ...(documentIds
        ? {
          OR: documentIds.map((documentId) => ({
            payload: { path: ["documentId"], equals: documentId },
          })),
        }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      payload: true,
      availableAt: true,
      lockToken: true,
      lockedUntil: true,
    },
  })
  for (const job of jobs) {
    const now = new Date()
    // 历史任务的安全等待窗口和未到期租约不能跳过。
    if (
      job.availableAt > now ||
      (job.status === "RUNNING" && job.lockedUntil && job.lockedUntil > now)
    ) {
      result.pending++
      continue
    }
    const lockToken = randomUUID()
    const claimed = await prisma.documentProcessingJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        lockToken: job.lockToken,
        lockedUntil: job.lockedUntil,
      },
      data: {
        status: "RUNNING",
        lockToken,
        lockedAt: now,
        lockedUntil: new Date(now.getTime() + DOCUMENT_PROCESSING_TIMEOUT_MS),
        attempts: { increment: 1 },
        lastError: null,
      },
    })
    if (claimed.count !== 1) {
      result.pending++
      continue
    }
    const active = { id: job.id, status: "RUNNING" as const, lockToken }
    try {
      await deleteKnowledgeCleanupResource(job.payload)
      const removed = await prisma.documentProcessingJob.deleteMany({
        where: active,
      })
      if (removed.count === 1) result.completed++
      else result.pending++
    } catch (error) {
      await prisma.documentProcessingJob.updateMany({
        where: active,
        data: {
          status: "FAILED",
          lockToken: null,
          lockedAt: null,
          lockedUntil: null,
          lastError: (error instanceof Error
            ? error.message
            : "资源清理失败"
          ).slice(0, 2000),
        },
      })
      console.error(`文档资源清理 ${job.id} 失败`, error)
      result.failed++
    }
  }
  return result
}
