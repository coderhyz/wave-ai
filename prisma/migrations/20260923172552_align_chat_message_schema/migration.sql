-- Keep fresh databases created from the initial migration aligned with the
-- current Prisma field name. The live database already uses "parts", so the
-- rename is guarded to make the migration safe in both states.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'messages'
          AND column_name = 'part'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'messages'
          AND column_name = 'parts'
    ) THEN
        ALTER TABLE "public"."messages" RENAME COLUMN "part" TO "parts";
    END IF;
END $$;

-- Replace the single-column indexes with indexes matching the main query
-- patterns: a user's recently updated chats and a chat's ordered messages.
DROP INDEX IF EXISTS "public"."chats_userId_idx";
DROP INDEX IF EXISTS "public"."messages_chatId_idx";

ALTER TABLE "public"."chats"
    ADD COLUMN IF NOT EXISTS "modelId" TEXT,
    ALTER COLUMN "title" SET DEFAULT '新对话';

ALTER TABLE "public"."messages"
    ADD COLUMN IF NOT EXISTS "metadata" JSONB,
    ADD COLUMN IF NOT EXISTS "modelId" TEXT,
    ADD COLUMN IF NOT EXISTS "finishReason" TEXT,
    ADD COLUMN IF NOT EXISTS "promptTokens" INTEGER,
    ADD COLUMN IF NOT EXISTS "completionTokens" INTEGER;

CREATE INDEX IF NOT EXISTS "chats_userId_updatedAt_idx"
    ON "public"."chats"("userId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "messages_chatId_createdAt_idx"
    ON "public"."messages"("chatId", "createdAt");
