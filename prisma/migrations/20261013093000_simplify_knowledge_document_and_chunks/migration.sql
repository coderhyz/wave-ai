-- 关键词检索使用 ES，移除未使用的 PostgreSQL 文本模糊检索索引。
DROP INDEX "document_chunks_content_trgm_idx";

-- 文档均通过上传创建；正文一致性只使用 contentRevision。
ALTER TABLE "knowledge_documents"
DROP COLUMN "source",
DROP COLUMN "revision";

DROP TYPE "KnowledgeDocumentSource";

-- 分块长度可从正文计算，内容哈希未参与去重或校验。
ALTER TABLE "document_chunks"
DROP COLUMN "checksum",
DROP COLUMN "charCount";
