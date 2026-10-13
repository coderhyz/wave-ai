import "server-only"

import {
  createAlibaba,
  type AlibabaEmbeddingModelOptions,
} from "@ai-sdk/alibaba"
import { embedMany } from "ai"
import type { KnowledgeChunk } from "@/lib/knowledge/indexing/chunk"
import { normalizeText } from "@/lib/knowledge/parsers/normalize"

// 文档和问题必须共用模型及维度；与现有 vector(1024) 字段保持一致。
export const EMBEDDING_MODEL = "text-embedding-v4"
export const EMBEDDING_DIMENSIONS = 1024
const REQUEST_TIMEOUT_MS = 30_000

async function embedTexts(
  values: string[],
  textType: "document" | "query",
  abortSignal?: AbortSignal
) {
  if (values.length === 0) return []

  const apiKey = process.env.QWEN_API_KEY?.trim()
  if (!apiKey) throw new Error("缺少 Embedding 环境变量：QWEN_API_KEY")

  const provider = createAlibaba({
    apiKey,
    // Embedding 使用原生 DashScope 接口，聊天的 baseURL 不会影响此地址。
    embeddingBaseURL: "https://dashscope.aliyuncs.com/api/v1",
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  })
  const { embeddings } = await embedMany({
    model: provider.embedding(EMBEDDING_MODEL),
    values,
    // SDK 按服务商的每批 10 条限制拆分；不叠加独立重试循环。
    maxParallelCalls: 1,
    maxRetries: 0,
    abortSignal,
    providerOptions: {
      alibaba: {
        textType,
        dimension: EMBEDDING_DIMENSIONS,
        outputType: "dense",
      } satisfies AlibabaEmbeddingModelOptions,
    },
  })

  // SDK 已检查响应结构、数值类型和数量，这里只检查数据库要求的维度。
  for (const embedding of embeddings) {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding 维度不匹配：期望 ${EMBEDDING_DIMENSIONS}，实际 ${embedding.length}`
      )
    }
  }
  return embeddings
}

/** 向量顺序与 chunks 一致；标题只用于模型输入，不改写原始 Chunk。 */
export async function embedDocumentChunks({
  documentTitle,
  chunks,
  abortSignal,
}: {
  documentTitle: string
  chunks: KnowledgeChunk[]
  abortSignal?: AbortSignal
}) {
  const values = chunks.map((chunk) =>
    [documentTitle, chunk.metadata.headingPath.join(" / "), chunk.content]
      .map((part) => normalizeText(part).trim())
      .filter(Boolean)
      .join("\n\n")
  )
  const embeddings = await embedTexts(values, "document", abortSignal)
  return { embeddingModel: EMBEDDING_MODEL, embeddings }
}

/** 问题使用 query 输入类型，仍与文档处于同一向量空间。 */
export async function embedQuery(query: string, abortSignal?: AbortSignal) {
  const value = normalizeText(query).trim()
  if (!value) throw new Error("Embedding 问题不能为空")

  const embeddings = await embedTexts([value], "query", abortSignal)
  return { embeddingModel: EMBEDDING_MODEL, embedding: embeddings[0] }
}
