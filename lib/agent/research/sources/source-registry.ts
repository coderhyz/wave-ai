import "server-only"

import type { ChunkHit } from "@/lib/knowledge/retrieval/search"
import {
  dedupeEvidence,
  extractEvidence,
  type ResearchEvidence,
  type ResearchSource,
} from "./evidence"

/** 保留查询参数，合并锚点；带凭据或非 HTTP(S) 地址不能成为候选网页。 */
export function canonicalizeSourceUrl(value: string) {
  const url = URL.parse(value)
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return undefined
  }
  url.hash = ""
  return url.href
}

/** 每次已认证研究请求独立创建，只有成功的搜索工具结果可以登记候选来源。 */
export function createSourceRegistry() {
  const sources = new Map<string, ResearchSource>()
  let evidence: ResearchEvidence[] = []

  return {
    registerSource(input: {
      url: string
      title: string
      publishedAt: string | null
    }) {
      const url = canonicalizeSourceUrl(input.url)
      if (!url) return undefined
      const existing = sources.get(url)
      if (existing) return existing
      const source: ResearchSource = {
        id: crypto.randomUUID(),
        kind: "web",
        title: input.title,
        url,
        ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      }
      sources.set(url, source)
      return source
    },
    getSource(url: string) {
      const canonical = canonicalizeSourceUrl(url)
      return canonical ? sources.get(canonical) : undefined
    },
    recordSearchSummary(sourceId: string, content: string) {
      const extracted = extractEvidence(
        sourceId,
        content,
        new Date().toISOString()
      ).map((item) => ({
        ...item,
        evidenceKind: "search-summary" as const,
      }))
      evidence = dedupeEvidence([...evidence, ...extracted])
    },
    recordKnowledgeChunk(
      chunk: Pick<
        ChunkHit,
        | "documentId"
        | "documentTitle"
        | "chunkId"
        | "contentRevision"
        | "chunkIndex"
        | "content"
      >
    ) {
      const key = `knowledge:${chunk.documentId}`
      let source = sources.get(key)
      if (!source) {
        source = {
          id: crypto.randomUUID(),
          kind: "knowledge",
          title: chunk.documentTitle,
          documentId: chunk.documentId,
        }
        sources.set(key, source)
      }
      const extracted = extractEvidence(
        source.id,
        chunk.content.slice(0, 12_000),
        new Date().toISOString()
      ).map((item) => ({
        ...item,
        evidenceKind: "knowledge-chunk" as const,
        locator: {
          ...item.locator,
          chunkId: chunk.chunkId,
          contentRevision: chunk.contentRevision,
          chunkIndex: chunk.chunkIndex,
        },
      }))
      evidence = dedupeEvidence([...evidence, ...extracted])
    },
    recordWebContent(url: string, content: string, fetchedAt: string) {
      const source = sources.get(url)
      if (!source) throw new Error("网页证据必须属于本次已登记来源")
      const extracted = extractEvidence(source.id, content, fetchedAt)
      evidence = dedupeEvidence([...evidence, ...extracted])
      source.fetchedAt = fetchedAt
      const contentHashes = new Set(extracted.map((item) => item.contentHash))
      return evidence.filter(
        (item) =>
          item.sourceId === source.id &&
          item.evidenceKind === "web-content" &&
          contentHashes.has(item.contentHash)
      )
    },
    listSources: () => [...sources.values()],
    listEvidence: () => [...evidence],
  }
}
