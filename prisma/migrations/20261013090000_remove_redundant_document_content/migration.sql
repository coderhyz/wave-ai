-- Markdown 是知识库唯一正文，移除不再使用的富文本和纯文本副本。
ALTER TABLE "knowledge_documents"
DROP COLUMN "contentJson",
DROP COLUMN "plainText";
