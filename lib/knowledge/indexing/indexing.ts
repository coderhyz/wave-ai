import "server-only"

import { Prisma } from "@/app/generated/prisma"
import {
  getKnowledgeChunkId,
  type KnowledgeChunk,
} from "@/lib/knowledge/indexing/chunk"
import type { KnowledgeTransaction } from "@/lib/knowledge/ownership"

/** 调用方已在事务内锁定文档并核实版本、租约；替换失败时旧索引一起回滚。 */
export async function replaceDocumentChunks(
  db: KnowledgeTransaction,
  {
    documentId,
    contentRevision,
    chunks,
    embeddings,
    embeddingModel,
  }: {
    documentId: string
    contentRevision: number
    chunks: KnowledgeChunk[]
    embeddings: number[][]
    embeddingModel: string
  }
) {
  await db.documentChunk.deleteMany({ where: { documentId } })

  // 控制单条 SQL 的参数和向量体积；全部批次仍在同一事务中。
  for (let offset = 0; offset < chunks.length; offset += 100) {
    const rows = chunks.slice(offset, offset + 100).map((chunk, index) => {
      const vector = `[${embeddings[offset + index].join(",")}]`
      return Prisma.sql`(
        ${getKnowledgeChunkId(documentId, contentRevision, chunk.chunkIndex)}, ${documentId}, ${contentRevision}, ${chunk.chunkIndex},
        ${chunk.content}, ${JSON.stringify(chunk.metadata)}::jsonb,
        ${vector}::vector(1024), ${embeddingModel}, CURRENT_TIMESTAMP
      )`
    })
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "document_chunks" (
        "id", "documentId", "contentRevision", "chunkIndex", "content",
        "metadata", "embedding", "embeddingModel", "createdAt"
      ) VALUES ${Prisma.join(rows)}
    `)
  }
}
