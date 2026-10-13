import "server-only"

import { z } from "zod"
import type { Prisma } from "@/app/generated/prisma"

const REQUEST_TIMEOUT_MS = 10_000
const MAX_DOCUMENT_CHARS = 2000

const configSchema = z.object({
  apiKey: z.string({ error: "缺少重排环境变量：QWEN_API_KEY" }).trim().min(1),
  url: z
    .url({ error: "缺少或无效的重排环境变量：RAG_RERANK_URL" })
    .refine(
      (value) => new URL(value).protocol === "https:",
      "重排接口必须使用 HTTPS"
    ),
  model: z.string().trim().min(1).default("qwen3-rerank"),
  minScore: z.coerce.number().min(0).max(1).default(0.4),
})

/** null 表示未启用；空数组表示重排成功，但没有块达到阈值。 */
export async function rerankChunks({
  query,
  chunks,
  abortSignal,
}: {
  query: string
  chunks: {
    documentTitle: string
    content: string
    metadata: Prisma.JsonValue | null
  }[]
  abortSignal?: AbortSignal
}) {
  abortSignal?.throwIfAborted()
  const enabled = z
    .enum(["true", "false"])
    .default("true")
    .parse(process.env.RAG_RERANK_ENABLED)
  if (enabled === "false") return null
  if (!chunks.length) return []

  const config = configSchema.parse({
    apiKey: process.env.QWEN_API_KEY,
    url: process.env.RAG_RERANK_URL,
    model: process.env.RAG_RERANK_MODEL,
    minScore: process.env.RAG_RERANK_MIN_SCORE,
  })
  const documents = chunks.map((chunk) => {
    const metadata = chunk.metadata
    const headingPath =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata.headingPath
        : null
    const heading = Array.isArray(headingPath)
      ? headingPath.filter((part) => typeof part === "string").join(" / ")
      : ""
    return [chunk.documentTitle, heading, chunk.content]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_DOCUMENT_CHARS)
  })
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: { query, documents },
      // 对全部 RRF 候选打分，阈值过滤和最终 Top K 在本地完成。
      parameters: { top_n: chunks.length, return_documents: false },
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(abortSignal ? [abortSignal] : []),
    ]),
  })
  if (!response.ok) throw new Error(`重排接口请求失败：HTTP ${response.status}`)

  // 校验第三方索引、数量及分数，避免错配 Chunk 或把不完整响应当成低分过滤。
  const { output } = z
    .object({
      code: z.literal("").optional(),
      output: z.object({
        results: z
          .array(
            z.object({
              index: z
                .number()
                .int()
                .min(0)
                .max(chunks.length - 1),
              relevance_score: z.number().min(0).max(1),
            })
          )
          .length(chunks.length),
      }),
    })
    .parse(await response.json())
  if (
    new Set(output.results.map((result) => result.index)).size !== chunks.length
  )
    throw new Error("重排接口返回了重复的候选索引")

  return output.results
    .filter((result) => result.relevance_score >= config.minScore)
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .map((result) => ({ index: result.index, score: result.relevance_score }))
}
