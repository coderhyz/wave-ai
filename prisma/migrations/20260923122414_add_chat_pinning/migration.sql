-- DropIndex
DROP INDEX "public"."chats_userId_updatedAt_idx";

-- AlterTable
ALTER TABLE "public"."chats" ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "chats_userId_isPinned_pinnedAt_updatedAt_idx" ON "public"."chats"("userId", "isPinned" DESC, "pinnedAt" DESC, "updatedAt" DESC);
