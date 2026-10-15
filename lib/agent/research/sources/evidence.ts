import "server-only"

import { createHash } from "node:crypto"

export type ResearchSource = {
  id: string
  kind: "web" | "knowledge" | "paper"
  title: string
  url?: string
  documentId?: string
  doi?: string
  publishedAt?: string
  fetchedAt?: string
}

export type ResearchEvidence = {
  id: string
  sourceId: string
  evidenceKind:
    | "search-summary"
    | "web-content"
    | "knowledge-chunk"
    | "paper-metadata"
  // 子问题和论断由后续规划/评估阶段赋值；原文摘录本身不代表已验证论断。
  questionId?: string
  claim?: string
  excerpt: string
  locator: {
    startChar: number
    endChar: number
    chunkId?: string
    contentRevision?: number
    chunkIndex?: number
  }
  contentHash: string
  fetchedAt: string
  verification: "unverified" | "metadata" | "supported" | "conflict"
}

/** 只复制实际正文，定位为工具返回 content 的 UTF-16 字符偏移，不生成摘要或页码。 */
export function extractEvidence(
  sourceId: string,
  content: string,
  fetchedAt: string
) {
  const contentHash = createHash("sha256").update(content).digest("hex")
  const evidence: ResearchEvidence[] = []
  for (const paragraph of content.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)) {
    for (let offset = 0; offset < paragraph[0].length; offset += 1000) {
      const segment = paragraph[0].slice(offset, offset + 1000)
      const excerpt = segment.trim()
      if (!excerpt) continue
      const startChar = paragraph.index + offset + segment.indexOf(excerpt)
      evidence.push({
        id: crypto.randomUUID(),
        sourceId,
        evidenceKind: "web-content",
        excerpt,
        locator: { startChar, endChar: startChar + excerpt.length },
        contentHash,
        fetchedAt,
        verification: "unverified",
      })
      if (evidence.length === 24) return evidence
    }
  }
  return evidence
}

/** 同一来源、正文版本和原文摘录只保留一个证据 ID。 */
export function dedupeEvidence(items: ResearchEvidence[]) {
  const unique = new Map<string, ResearchEvidence>()
  for (const item of items) {
    const key = JSON.stringify([
      item.sourceId,
      item.evidenceKind,
      item.contentHash,
      item.excerpt,
      item.locator.chunkId,
      item.locator.contentRevision,
    ])
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()]
}
