import "server-only"

import { errors } from "@elastic/elasticsearch"
import { getEsClient } from "@/lib/es/es"
import {
  getKnowledgeChunkId,
  type KnowledgeChunk,
} from "@/lib/knowledge/indexing/chunk"

export const KNOWLEDGE_CHUNK_INDEX = "wave_ai_knowledge_chunks_v1"

export async function ensureKnowledgeChunkIndex() {
  const client = getEsClient()
  if (await client.indices.exists({ index: KNOWLEDGE_CHUNK_INDEX })) return
  try {
    await client.indices.create({
      index: KNOWLEDGE_CHUNK_INDEX,
      mappings: {
        dynamic: "strict",
        properties: {
          userId: { type: "keyword" },
          knowledgeBaseId: { type: "keyword" },
          documentId: { type: "keyword" },
          documentVersion: { type: "keyword" },
          contentRevision: { type: "integer" },
          chunkIndex: { type: "integer" },
          // 内置 CJK 分析器支持中文双字切分，不要求服务器安装 IK 插件。
          documentTitle: { type: "text", analyzer: "cjk" },
          heading: { type: "text", analyzer: "cjk" },
          content: { type: "text", analyzer: "cjk" },
        },
      },
    })
  } catch (error) {
    // 多个 Worker 首次初始化可能同时创建；只忽略已被另一实例创建的情况。
    if (
      !(error instanceof errors.ResponseError) ||
      error.body?.error?.type !== "resource_already_exists_exception"
    )
      throw error
  }
}

/** 先写 ES，再提交 PG 的 READY 状态；检索仅允许 PG 已确认的正文版本。 */
export async function indexKnowledgeChunks({
  userId,
  knowledgeBaseId,
  documentId,
  documentTitle,
  contentRevision,
  chunks,
  abortSignal,
}: {
  userId: string
  knowledgeBaseId: string
  documentId: string
  documentTitle: string
  contentRevision: number
  chunks: KnowledgeChunk[]
  abortSignal?: AbortSignal
}) {
  await ensureKnowledgeChunkIndex()
  const client = getEsClient()
  for (let offset = 0; offset < chunks.length; offset += 100) {
    const operations = chunks.slice(offset, offset + 100).flatMap((chunk) => [
      {
        index: {
          _id: getKnowledgeChunkId(
            documentId,
            contentRevision,
            chunk.chunkIndex
          ),
        },
      },
      {
        userId,
        knowledgeBaseId,
        documentId,
        documentVersion: `${documentId}:${contentRevision}`,
        documentTitle,
        contentRevision,
        chunkIndex: chunk.chunkIndex,
        heading: chunk.metadata.headingPath.join(" / "),
        content: chunk.content,
      },
    ])
    const response = await client.bulk(
      {
        index: KNOWLEDGE_CHUNK_INDEX,
        operations,
        refresh: "wait_for",
      },
      { signal: abortSignal, maxRetries: 0 }
    )
    if (response.errors) {
      const failure = response.items.find((item) => item.index?.error)?.index
        ?.error
      throw new Error(`ES 分块写入失败：${failure?.reason ?? "bulk 操作失败"}`)
    }
  }
  // 只删除更旧版本；晚到的旧任务不能删除新任务写入的块。
  const cleanup = await client.deleteByQuery(
    {
      index: KNOWLEDGE_CHUNK_INDEX,
      refresh: true,
      query: {
        bool: {
          filter: [
            { term: { documentId } },
            { range: { contentRevision: { lt: contentRevision } } },
          ],
        },
      },
    },
    { signal: abortSignal, maxRetries: 0 }
  )
  if (cleanup.timed_out || cleanup.failures?.length) {
    throw new Error("ES 旧版本分块清理失败")
  }
}

export async function searchKeywordChunks({
  userId,
  query,
  documentVersions,
  limit,
  abortSignal,
}: {
  userId: string
  query: string
  documentVersions: string[]
  limit: number
  abortSignal?: AbortSignal
}) {
  const response = await getEsClient().search(
    {
      index: KNOWLEDGE_CHUNK_INDEX,
      size: limit,
      _source: false,
      allow_partial_search_results: false,
      query: {
        bool: {
          filter: [
            { term: { userId } },
            // 除了权限过滤，还要在召回前排除旧版本，防止旧块占满 Top K。
            { terms: { documentVersion: documentVersions } },
          ],
          must: [
            {
              multi_match: {
                query,
                fields: ["documentTitle^2", "heading^2", "content"],
              },
            },
          ],
        },
      },
    },
    { signal: abortSignal }
  )
  if (response.timed_out || response._shards.failed) {
    throw new Error("ES 关键词检索未完整完成")
  }
  return response.hits.hits.map((hit) => {
    if (!hit._id || hit._score == null)
      throw new Error("ES 检索结果缺少块 ID 或分数")
    return { chunkId: hit._id, score: hit._score }
  })
}

/** 删除失败保留资源清单供补偿；索引不存在代表已清理，不创建空索引。 */
export async function deleteKnowledgeChunks(documentId: string) {
  const client = getEsClient()
  if (!(await client.indices.exists({ index: KNOWLEDGE_CHUNK_INDEX }))) return
  const result = await client.deleteByQuery(
    {
      index: KNOWLEDGE_CHUNK_INDEX,
      refresh: true,
      query: { term: { documentId } },
    },
    { maxRetries: 0 }
  )
  if (result.timed_out || result.failures?.length)
    throw new Error("ES 文档分块清理失败")
}
