-- 只扩展现有 Chunk 表；正文仍以 knowledge_documents 为唯一来源。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "knowledge_documents" ADD COLUMN "chunkErrorMessage" TEXT;
ALTER TABLE "document_chunks" ADD COLUMN "embedding" vector(1024), ADD COLUMN "embeddingModel" TEXT;
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "document_chunks_content_trgm_idx" ON "document_chunks" USING gin ("content" gin_trgm_ops);
