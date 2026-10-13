ALTER TABLE "chats" ADD COLUMN "documentId" TEXT;
CREATE INDEX "chats_userId_documentId_createdAt_idx" ON "chats"("userId", "documentId", "createdAt" DESC);
ALTER TABLE "chats" ADD CONSTRAINT "chats_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
