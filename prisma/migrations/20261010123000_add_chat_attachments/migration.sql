-- CreateTable
CREATE TABLE "public"."chat_attachments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "extractedText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_attachments_storageKey_key" ON "public"."chat_attachments"("storageKey");
CREATE INDEX "chat_attachments_userId_createdAt_idx" ON "public"."chat_attachments"("userId", "createdAt");
CREATE INDEX "chat_attachments_messageId_idx" ON "public"."chat_attachments"("messageId");

ALTER TABLE "public"."chat_attachments" ADD CONSTRAINT "chat_attachments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."chat_attachments" ADD CONSTRAINT "chat_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
