-- CreateEnum
CREATE TYPE "public"."KnowledgeDocumentType" AS ENUM ('PDF', 'DOCX', 'MARKDOWN', 'TEXT');

-- CreateEnum
CREATE TYPE "public"."KnowledgeDocumentSource" AS ENUM ('UPLOAD', 'MANUAL');

-- CreateEnum
CREATE TYPE "public"."KnowledgeDocumentStatus" AS ENUM ('QUEUED', 'PARSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."DocumentChunkStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."DocumentProcessingJobType" AS ENUM ('PARSE', 'REPARSE', 'RECHUNK', 'CLEANUP');

-- CreateEnum
CREATE TYPE "public"."DocumentProcessingJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."knowledge_bases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."knowledge_folders" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "knowledge_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."knowledge_documents" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "folderId" TEXT,
    "title" TEXT NOT NULL,
    "type" "public"."KnowledgeDocumentType" NOT NULL,
    "source" "public"."KnowledgeDocumentSource" NOT NULL,
    "status" "public"."KnowledgeDocumentStatus" NOT NULL DEFAULT 'QUEUED',
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "checksumSha256" TEXT,
    "storageKey" TEXT,
    "contentJson" JSONB,
    "plainText" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "contentRevision" INTEGER NOT NULL DEFAULT 0,
    "parserVersion" TEXT,
    "parseMetadata" JSONB,
    "parseErrorCode" TEXT,
    "parseErrorMessage" TEXT,
    "parsedAt" TIMESTAMP(3),
    "chunkedContentRevision" INTEGER,
    "chunkStatus" "public"."DocumentChunkStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "contentRevision" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "metadata" JSONB,
    "charCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_processing_jobs" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT,
    "documentId" TEXT,
    "type" "public"."DocumentProcessingJobType" NOT NULL,
    "status" "public"."DocumentProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "targetRevision" INTEGER,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "lockToken" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_bases_userId_deletedAt_idx" ON "public"."knowledge_bases"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "knowledge_folders_knowledgeBaseId_parentId_deletedAt_sortOr_idx" ON "public"."knowledge_folders"("knowledgeBaseId", "parentId", "deletedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "knowledge_documents_knowledgeBaseId_folderId_deletedAt_stat_idx" ON "public"."knowledge_documents"("knowledgeBaseId", "folderId", "deletedAt", "status");

-- CreateIndex
CREATE INDEX "knowledge_documents_knowledgeBaseId_deletedAt_updatedAt_idx" ON "public"."knowledge_documents"("knowledgeBaseId", "deletedAt", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_documentId_contentRevision_chunkIndex_key" ON "public"."document_chunks"("documentId", "contentRevision", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "document_processing_jobs_dedupeKey_key" ON "public"."document_processing_jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "document_processing_jobs_status_availableAt_idx" ON "public"."document_processing_jobs"("status", "availableAt");

-- CreateIndex
CREATE INDEX "document_processing_jobs_status_lockedUntil_idx" ON "public"."document_processing_jobs"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "document_processing_jobs_knowledgeBaseId_status_idx" ON "public"."document_processing_jobs"("knowledgeBaseId", "status");

-- CreateIndex
CREATE INDEX "document_processing_jobs_documentId_status_idx" ON "public"."document_processing_jobs"("documentId", "status");

-- AddForeignKey
ALTER TABLE "public"."knowledge_bases" ADD CONSTRAINT "knowledge_bases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."knowledge_folders" ADD CONSTRAINT "knowledge_folders_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "public"."knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."knowledge_folders" ADD CONSTRAINT "knowledge_folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."knowledge_documents" ADD CONSTRAINT "knowledge_documents_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "public"."knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."knowledge_documents" ADD CONSTRAINT "knowledge_documents_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "public"."knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_chunks" ADD CONSTRAINT "document_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_processing_jobs" ADD CONSTRAINT "document_processing_jobs_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "public"."knowledge_bases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_processing_jobs" ADD CONSTRAINT "document_processing_jobs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."knowledge_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
