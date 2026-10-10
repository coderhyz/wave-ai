import assert from "node:assert/strict"
import { existsSync, statSync } from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

const resolveLocalModule = (basePath) => {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js"),
  ]

  return candidates.find(
    (candidate) => existsSync(candidate) && !statSync(candidate).isDirectory()
  )
}

/**
 * Node 的类型转换能直接执行项目 TS；这里补上 tsconfig 中 @/ 和省略扩展名的解析。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    let basePath
    if (specifier.startsWith("@/")) {
      basePath = path.join(projectRoot, specifier.slice(2))
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      basePath = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier
      )
    }

    const localModule = basePath && resolveLocalModule(basePath)
    if (localModule) {
      return { url: pathToFileURL(localModule).href, shortCircuit: true }
    }

    return nextResolve(specifier, context)
  },
})

const testDatabaseUrl = process.env.KNOWLEDGE_TEST_DATABASE_URL

/** 不连接数据库也可以执行的 Zod 输入边界测试。 */
test("知识库与目录请求参数校验", async () => {
  const {
    createKnowledgeBaseSchema,
    createKnowledgeFolderSchema,
    deleteKnowledgeFolderQuerySchema,
    knowledgeIdParamSchema,
    updateKnowledgeBaseSchema,
  } = await import("../lib/knowledge/schemas.ts")

  assert.deepEqual(createKnowledgeBaseSchema.parse({ name: " 研发资料 " }), {
    name: "研发资料",
    description: null,
  })
  assert.equal(
    createKnowledgeBaseSchema.safeParse({ name: "研发资料", extra: true })
      .success,
    false
  )
  assert.equal(updateKnowledgeBaseSchema.safeParse({}).success, false)
  assert.deepEqual(createKnowledgeFolderSchema.parse({ name: "接口" }), {
    name: "接口",
    parentId: null,
    sortOrder: 0,
  })
  assert.equal(
    knowledgeIdParamSchema.safeParse({ id: "not-a-uuid" }).success,
    false
  )
  assert.deepEqual(deleteKnowledgeFolderQuerySchema.parse({}), {
    recursive: false,
  })
  assert.deepEqual(
    deleteKnowledgeFolderQuerySchema.parse({ recursive: "true" }),
    { recursive: true }
  )
})

/**
 * 需要隔离 PostgreSQL schema 的业务集成测试。
 * 未提供 KNOWLEDGE_TEST_DATABASE_URL 时自动跳过，避免误写开发数据库。
 */
test(
  "知识库所有权、目录移动、防循环和子树删除",
  { skip: testDatabaseUrl ? false : "未配置隔离测试数据库" },
  async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    const service = await import("../lib/knowledge/service.ts")
    const { KnowledgeError } = await import("../lib/knowledge/errors.ts")
    const { default: prisma } = await import("../lib/prisma.ts")

    const userA = "kb02-user-a"
    const userB = "kb02-user-b"
    try {
      await prisma.user.createMany({
        data: [
          {
            id: userA,
            name: "用户 A",
            email: "kb02-a@example.invalid",
            emailVerified: false,
          },
          {
            id: userB,
            name: "用户 B",
            email: "kb02-b@example.invalid",
            emailVerified: false,
          },
        ],
      })

      const knowledgeA = await service.createKnowledgeBase(userA, {
        name: "A 的知识库",
        description: null,
      })
      const knowledgeB = await service.createKnowledgeBase(userB, {
        name: "B 的知识库",
        description: null,
      })

      assert.deepEqual(
        (await service.listKnowledgeBases(userA)).map(({ id }) => id),
        [knowledgeA.id]
      )
      await assert.rejects(
        service.getKnowledgeTree(userB, knowledgeA.id),
        (error) =>
          error instanceof KnowledgeError &&
          error.code === "KNOWLEDGE_BASE_NOT_FOUND" &&
          error.status === 404
      )

      const root = await service.createKnowledgeFolder(userA, knowledgeA.id, {
        name: "根目录",
        parentId: null,
        sortOrder: 0,
      })
      const child = await service.createKnowledgeFolder(userA, knowledgeA.id, {
        name: "子目录",
        parentId: root.id,
        sortOrder: 0,
      })
      const foreignFolder = await service.createKnowledgeFolder(
        userB,
        knowledgeB.id,
        { name: "其他用户目录", parentId: null, sortOrder: 0 }
      )

      await assert.rejects(
        service.createKnowledgeFolder(userA, knowledgeA.id, {
          name: "越权目录",
          parentId: foreignFolder.id,
          sortOrder: 0,
        }),
        (error) =>
          error instanceof KnowledgeError &&
          error.code === "KNOWLEDGE_FOLDER_NOT_FOUND"
      )
      await assert.rejects(
        service.updateKnowledgeFolder(userA, root.id, {
          parentId: child.id,
        }),
        (error) =>
          error instanceof KnowledgeError &&
          error.code === "KNOWLEDGE_FOLDER_CYCLE" &&
          error.status === 409
      )

      const left = await service.createKnowledgeFolder(userA, knowledgeA.id, {
        name: "并发目录 A",
        parentId: null,
        sortOrder: 1,
      })
      const right = await service.createKnowledgeFolder(userA, knowledgeA.id, {
        name: "并发目录 B",
        parentId: null,
        sortOrder: 2,
      })
      const concurrentMoves = await Promise.allSettled([
        service.updateKnowledgeFolder(userA, left.id, { parentId: right.id }),
        service.updateKnowledgeFolder(userA, right.id, { parentId: left.id }),
      ])
      assert.equal(
        concurrentMoves.filter(({ status }) => status === "fulfilled").length,
        1
      )
      assert.equal(
        concurrentMoves.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof KnowledgeError &&
            result.reason.code === "KNOWLEDGE_FOLDER_CYCLE"
        ).length,
        1
      )

      const document = await prisma.knowledgeDocument.create({
        data: {
          knowledgeBaseId: knowledgeA.id,
          folderId: child.id,
          title: "待清理文档",
          type: "TEXT",
          source: "UPLOAD",
          storageKey: "kb02/test.txt",
          checksumSha256: "kb02-checksum",
        },
      })
      const parseJob = await prisma.documentProcessingJob.create({
        data: {
          knowledgeBaseId: knowledgeA.id,
          documentId: document.id,
          type: "PARSE",
          dedupeKey: `parse:${document.id}`,
          payload: {},
        },
      })

      await assert.rejects(
        service.deleteKnowledgeFolder(userA, root.id, false),
        (error) =>
          error instanceof KnowledgeError &&
          error.code === "KNOWLEDGE_FOLDER_NOT_EMPTY" &&
          error.details?.folderCount === 1 &&
          error.details?.documentCount === 1
      )
      const deletion = await service.deleteKnowledgeFolder(userA, root.id, true)
      assert.equal(deletion.folderCount, 2)
      assert.equal(deletion.documentCount, 1)

      const [storedDocument, storedParseJob, cleanupJob] = await Promise.all([
        prisma.knowledgeDocument.findUnique({ where: { id: document.id } }),
        prisma.documentProcessingJob.findUnique({ where: { id: parseJob.id } }),
        prisma.documentProcessingJob.findUnique({
          where: { dedupeKey: `cleanup:${document.id}:kb02-checksum` },
        }),
      ])
      assert.ok(storedDocument?.deletedAt)
      assert.equal(storedParseJob?.status, "CANCELLED")
      assert.equal(cleanupJob?.status, "PENDING")
      assert.deepEqual(cleanupJob?.payload, {
        storageKey: "kb02/test.txt",
        documentId: document.id,
        reason: "folder-delete",
      })

      const tree = await service.getKnowledgeTree(userA, knowledgeA.id)
      assert.equal(
        tree.folders.some(({ id }) => id === root.id),
        false
      )
      assert.equal(
        tree.documents.some(({ id }) => id === document.id),
        false
      )

      const deletedKnowledgeBase = await service.deleteKnowledgeBase(
        userA,
        knowledgeA.id
      )
      assert.equal(deletedKnowledgeBase.id, knowledgeA.id)
      assert.equal((await service.listKnowledgeBases(userA)).length, 0)
      assert.equal((await service.listKnowledgeBases(userB)).length, 1)
    } finally {
      await prisma.$disconnect()
    }
  }
)
