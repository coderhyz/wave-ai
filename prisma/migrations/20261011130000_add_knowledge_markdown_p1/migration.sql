-- P1: make Markdown the canonical editable body.
ALTER TABLE "public"."knowledge_documents"
ADD COLUMN "markdownContent" TEXT;
