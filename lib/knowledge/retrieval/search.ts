import "server-only"

import { Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import { searchKeywordChunks } from "@/lib/es/knowledge-index"
import { embedQuery } from "@/lib/knowledge/indexing/embedding"
import { knowledgeDocumentNotFound } from "@/lib/knowledge/errors"
import { requireOwnedKnowledgeBase } from "@/lib/knowledge/ownership"
import { rerankChunks } from "@/lib/knowledge/retrieval/rerank"
import type { SearchKnowledgeInput } from "@/lib/knowledge/schemas"

const CANDIDATE_LIMIT = 20
const RRF_K = 60

type Candidate = { chunkId: string; score: number }
type RetrievedChunk = {
  chunkId: string
  documentId: string
  knowledgeBaseId: string
  documentTitle: string
  contentRevision: number
  chunkIndex: number
  content: string
  metadata: Prisma.JsonValue | null
}

export type ChunkHit = RetrievedChunk & {
  /** 保留 RRF 分数；重排分数单独存储，不能混用阈值。 */
  score: number
  vectorScore: number | null
  keywordScore: number | null
  vectorRank: number | null
  keywordRank: number | null
  rerankScore: number | null
}

type SearchWarning = {
  stage: "embedding" | "rerank"
  message: string
}

/** userId 来自服务端登录态；请求对象只在 HTTP 入口用 Zod 校验一次。 */
export async function searchKnowledge(
  userId: string,
  input: SearchKnowledgeInput,
  abortSignal?: AbortSignal
): Promise<{ items: ChunkHit[]; warnings: SearchWarning[] }> {
  abortSignal?.throwIfAborted()
  const { query, knowledgeBaseId, documentId, mode, limit } = input
  const warnings: SearchWarning[] = []

  // 先检查指定资源的归属，越权请求不调用第三方 Embedding/ES。
  if (knowledgeBaseId) {
    await requireOwnedKnowledgeBase(prisma, userId, knowledgeBaseId)
  }
  if (documentId) {
    const document = await prisma.knowledgeDocument.findFirst({
      where: {
        id: documentId,
        deletedAt: null,
        ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
        knowledgeBase: { userId, deletedAt: null },
      },
      select: { id: true },
    })
    if (!document) throw knowledgeDocumentNotFound()
  }

  const scope = Prisma.sql`
    k."userId" = ${userId} AND k."deletedAt" IS NULL
    AND d."deletedAt" IS NULL AND d."status" = 'READY'
    AND d."chunkStatus" = 'READY'
    AND d."chunkedContentRevision" = d."contentRevision"
    ${knowledgeBaseId ? Prisma.sql`AND d."knowledgeBaseId" = ${knowledgeBaseId}` : Prisma.empty}
    ${documentId ? Prisma.sql`AND d."id" = ${documentId}` : Prisma.empty}
  `
  const documents = await prisma.$queryRaw<
    { id: string; contentRevision: number }[]
  >(Prisma.sql`
    SELECT d."id", d."contentRevision"
    FROM "knowledge_documents" d
    JOIN "knowledge_bases" k ON k."id" = d."knowledgeBaseId"
    WHERE ${scope}
  `)
  if (!documents.length) return { items: [], warnings }

  const vectorRecall = async () => {
    const embedded = await embedQuery(query, abortSignal).catch((error) => {
      abortSignal?.throwIfAborted()
      // 只降级问题向量化失败；纯向量模式没有关键词通道，仍明确失败。
      if (mode === "vector") throw error
      console.warn(
        "知识库问题 Embedding 失败，降级为关键词检索",
        error instanceof Error ? error.message : "未知错误"
      )
      warnings.push({
        stage: "embedding",
        message: "问题向量生成失败，本次仅使用关键词检索",
      })
      return null
    })
    abortSignal?.throwIfAborted()
    if (!embedded) return []
    const { embedding, embeddingModel } = embedded
    const vector = `[${embedding.join(",")}]`
    // 先做有权限范围内的精确检索基线，避免 HNSW 全局召回后过滤导致漏召回。
    return prisma.$queryRaw<Candidate[]>(Prisma.sql`
      WITH eligible_chunks AS MATERIALIZED (
        SELECT c."id", c."embedding"
        FROM "document_chunks" c
        JOIN "knowledge_documents" d ON d."id" = c."documentId"
        JOIN "knowledge_bases" k ON k."id" = d."knowledgeBaseId"
        WHERE ${scope} AND c."contentRevision" = d."contentRevision"
          AND c."embeddingModel" = ${embeddingModel} AND c."embedding" IS NOT NULL
      )
      SELECT "id" AS "chunkId", 1 - ("embedding" <=> ${vector}::vector(1024)) AS "score"
      FROM eligible_chunks
      ORDER BY "embedding" <=> ${vector}::vector(1024), "id"
      LIMIT ${CANDIDATE_LIMIT}
    `)
  }
  const [vectorCandidates, keywordCandidates] = await Promise.all([
    vectorRecall(),
    mode === "hybrid"
      ? searchKeywordChunks({
          userId,
          query,
          limit: CANDIDATE_LIMIT,
          documentVersions: documents.map(
            (document) => `${document.id}:${document.contentRevision}`
          ),
          abortSignal,
        })
      : Promise.resolve<Candidate[]>([]),
  ])
  abortSignal?.throwIfAborted()
  const ids = [
    ...new Set(
      [...vectorCandidates, ...keywordCandidates].map(
        (candidate) => candidate.chunkId
      )
    ),
  ]
  if (!ids.length) return { items: [], warnings }

  // 两路召回期间文档可能被修改或删除：统一回查 PG，正文及标题不信任 ES 副本。
  const chunks = await prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
    SELECT c."id" AS "chunkId", c."documentId", d."knowledgeBaseId",
      d."title" AS "documentTitle", c."contentRevision", c."chunkIndex", c."content", c."metadata"
    FROM "document_chunks" c
    JOIN "knowledge_documents" d ON d."id" = c."documentId"
    JOIN "knowledge_bases" k ON k."id" = d."knowledgeBaseId"
    WHERE ${scope} AND c."contentRevision" = d."contentRevision"
      AND c."id" IN (${Prisma.join(ids)})
  `)
  const current = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]))
  const ranked = new Map<string, ChunkHit>()
  for (const [source, candidates] of [
    ["vector", vectorCandidates],
    ["keyword", keywordCandidates],
  ] as const) {
    const valid = candidates.flatMap((candidate) => {
      const chunk = current.get(candidate.chunkId)
      return chunk ? [{ candidate, chunk }] : []
    })
    for (const [index, { candidate, chunk }] of valid.entries()) {
      const result = ranked.get(candidate.chunkId) ?? {
        ...chunk,
        score: 0,
        vectorScore: null,
        keywordScore: null,
        vectorRank: null,
        keywordRank: null,
        rerankScore: null,
      }
      const rank = index + 1
      result.score += 1 / (RRF_K + rank)
      if (source === "vector") {
        result.vectorScore = candidate.score
        result.vectorRank = rank
      } else {
        result.keywordScore = candidate.score
        result.keywordRank = rank
      }
      ranked.set(candidate.chunkId, result)
    }
  }
  const fused = [...ranked.values()].sort(
    (a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)
  )
  if (!fused.length) return { items: [], warnings }
  abortSignal?.throwIfAborted()

  let items = fused
  let rerankAttempted = false
  try {
    const results = await rerankChunks({ query, chunks: fused, abortSignal })
    if (results !== null) {
      rerankAttempted = true
      items = results.map((result) => ({
        ...fused[result.index],
        rerankScore: result.score,
      }))
    }
  } catch (error) {
    abortSignal?.throwIfAborted()
    rerankAttempted = true
    console.warn(
      "知识库重排失败，保留 RRF 排序",
      error instanceof Error ? error.message : "未知错误"
    )
    warnings.push({ stage: "rerank", message: "重排失败，本次使用 RRF 排序" })
  }
  abortSignal?.throwIfAborted()

  if (rerankAttempted && items.length) {
    // 重排是外部网络请求，等待期间可能删除或重解析文档；返回前再确认版本和权限。
    const latest = await prisma.$queryRaw<{ chunkId: string }[]>(Prisma.sql`
      SELECT c."id" AS "chunkId"
      FROM "document_chunks" c
      JOIN "knowledge_documents" d ON d."id" = c."documentId"
      JOIN "knowledge_bases" k ON k."id" = d."knowledgeBaseId"
      WHERE ${scope} AND c."contentRevision" = d."contentRevision"
        AND c."id" IN (${Prisma.join(items.map((item) => item.chunkId))})
    `)
    const latestIds = new Set(latest.map((chunk) => chunk.chunkId))
    items = items.filter((item) => latestIds.has(item.chunkId))
  }
  abortSignal?.throwIfAborted()
  return { items: items.slice(0, limit), warnings }
}
