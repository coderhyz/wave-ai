/**
 * 知识库与文件夹领域服务。
 * 集中处理所有权校验、目录层级、排序和删除事务，供 API 路由调用。
 */
import type { DocumentChunkStatus, Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import { DOCUMENT_PROCESSING_TIMEOUT_MS } from "@/lib/knowledge/documents/timeouts"
import { cleanupKnowledgeResources } from "@/lib/knowledge/documents/cleanup"
import {
  getKnowledgeAssetNames,
  getKnowledgeAssetStorageKey,
} from "@/lib/knowledge/documents/assets"
import {
  KnowledgeError,
  knowledgeFolderCycle,
  knowledgeFolderNotEmpty,
  knowledgeDocumentNotFound,
} from "@/lib/knowledge/errors"
import {
  lockOwnedKnowledgeBase,
  requireFolderInKnowledgeBase,
  requireOwnedKnowledgeBase,
  requireOwnedKnowledgeFolder,
  type KnowledgeTransaction,
} from "@/lib/knowledge/ownership"
import type {
  CreateKnowledgeBaseInput,
  CreateKnowledgeFolderInput,
  UpdateKnowledgeBaseInput,
  UpdateKnowledgeFolderInput,
} from "@/lib/knowledge/schemas"

/**
 * 目录结构写操作的统一事务配置。
 * 同库咨询锁负责串行写入，READ COMMITTED 让等待者随后读到刚提交的新结构。
 */
const organizationTransactionOptions = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5_000,
  timeout: 10_000,
}

/** 知识库列表和更新接口允许返回给客户端的字段。 */
const knowledgeBaseSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeBaseSelect

/** 文件树中的目录摘要；不包含软删除等内部字段。 */
const folderSelect = {
  id: true,
  knowledgeBaseId: true,
  parentId: true,
  name: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeFolderSelect

/**
 * 文件树中的文档摘要。
 * 正文、解析详情和 storageKey 等敏感或体积较大的字段不会由 tree 接口返回。
 */
const documentTreeSelect = {
  id: true,
  knowledgeBaseId: true,
  folderId: true,
  title: true,
  type: true,
  status: true,
  contentRevision: true,
  chunkStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeDocumentSelect

/**
 * 从指定目录开始，按层收集整棵子树 ID，包括历史软删除目录。
 * visited 还能防止异常旧数据中的环路造成无限查询。
 */
const getFolderSubtreeIds = async (
  db: KnowledgeTransaction,
  knowledgeBaseId: string,
  folderId: string
) => {
  const visited = new Set([folderId])
  let pendingParentIds = [folderId]

  while (pendingParentIds.length > 0) {
    /** 一次查询当前这一层的直接子目录，避免递归函数产生大量嵌套调用。 */
    const children = await db.knowledgeFolder.findMany({
      where: {
        knowledgeBaseId,
        parentId: { in: pendingParentIds },
      },
      select: { id: true },
    })

    /** 只把尚未访问的目录放入下一轮，同时记录已经找到的全部目录 ID。 */
    pendingParentIds = children
      .map(({ id }) => id)
      .filter((id) => {
        if (visited.has(id)) return false
        visited.add(id)
        return true
      })
  }

  return [...visited]
}

/** 删除和处理使用同一知识库锁；先拒绝在途写入，再登记资源清单。 */
const assertDocumentsIdle = async (
  db: KnowledgeTransaction,
  documentIds: string[]
) => {
  if (!documentIds.length) return
  const busy = await db.knowledgeDocument.findFirst({
    where: {
      id: { in: documentIds },
      OR: [
        { status: { in: ["QUEUED", "PARSING"] } },
        { chunkStatus: "RUNNING" },
        {
          jobs: {
            some: {
              type: { in: ["PARSE", "REPARSE", "RECHUNK"] },
              status: "RUNNING",
            },
          },
        },
      ],
    },
    select: { id: true },
  })
  if (busy)
    throw new KnowledgeError(
      "KNOWLEDGE_DOCUMENT_PROCESSING",
      "包含正在处理的文档，请等待解析和索引结束后再删除",
      409
    )
}

/**
 * 为原件、解析图片和 ES 块登记清理任务；重解析只清理旧图片。
 * payload 保存资源定位字段，文档被物理删除后仍能执行清理。
 */
export const registerCleanupJobs = async (
  db: KnowledgeTransaction,
  documents: Array<{
    id: string
    knowledgeBaseId: string
    storageKey: string | null
    checksumSha256: string | null
    parseMetadata: Prisma.JsonValue | null
    chunkStatus: DocumentChunkStatus
    updatedAt: Date
  }>,
  reason:
    | "knowledge-base-delete"
    | "folder-delete"
    | "document-delete"
    | "reparse"
) => {
  const jobs = documents.flatMap((document) => {
    const storageItems = [
      ...(document.storageKey
        ? [
          {
            storageKey: document.storageKey,
            suffix: document.checksumSha256 ?? document.storageKey,
          },
        ]
        : []),
      ...getKnowledgeAssetNames(document.parseMetadata).map((assetName) => ({
        storageKey: getKnowledgeAssetStorageKey(document.id, assetName),
        suffix: assetName,
      })),
    ]
    const storageJobs = storageItems.map(({ storageKey, suffix }) => ({
      knowledgeBaseId: document.knowledgeBaseId,
      documentId: document.id,
      type: "CLEANUP" as const,
      status: "PENDING" as const,
      dedupeKey: `cleanup:${document.id}:${suffix}`,
      payload: {
        storageKey,
        documentId: document.id,
        reason,
      } satisfies Prisma.InputJsonObject,
    }))
    if (reason === "reparse") return storageJobs
    return [
      ...storageJobs,
      {
        knowledgeBaseId: document.knowledgeBaseId,
        documentId: document.id,
        type: "CLEANUP" as const,
        status: "PENDING" as const,
        dedupeKey: `cleanup:es:${document.id}`,
        // 索引失败可能有服务端未确认的写入，保留安全窗口后再补偿；其余立即执行。
        availableAt:
          document.chunkStatus === "FAILED"
            ? new Date(
                Math.max(
                  Date.now(),
                  document.updatedAt.getTime() + DOCUMENT_PROCESSING_TIMEOUT_MS
                )
              )
            : new Date(),
        payload: { target: "elasticsearch", documentId: document.id, reason },
      },
    ]
  })

  if (jobs.length > 0) {
    /** dedupeKey 配合 skipDuplicates，避免重复删除请求生成相同清理任务。 */
    await db.documentProcessingJob.createMany({
      data: jobs,
      skipDuplicates: true,
    })
  }
}

/** 先提交删除及资源清单，再在事务外立即清理 OSS 和 ES。 */
export const deleteKnowledgeDocument = async (userId: string, id: string) => {
  const deleted = await prisma.$transaction(async (db) => {
    const where = {
      id,
      deletedAt: null,
      knowledgeBase: { userId, deletedAt: null },
    }
    const initial = await db.knowledgeDocument.findFirst({
      where,
      select: { knowledgeBaseId: true },
    })
    if (!initial) throw knowledgeDocumentNotFound()
    await lockOwnedKnowledgeBase(db, userId, initial.knowledgeBaseId)
    // 等锁期间可能被目录删除；拿到锁后再读取资源清单。
    const document = await db.knowledgeDocument.findFirst({
      where,
      select: {
        id: true,
        knowledgeBaseId: true,
        storageKey: true,
        checksumSha256: true,
        parseMetadata: true,
        chunkStatus: true,
        updatedAt: true,
      },
    })
    if (!document) throw knowledgeDocumentNotFound()
    await assertDocumentsIdle(db, [id])
    await registerCleanupJobs(db, [document], "document-delete")
    // 删除任务行使在途解析/索引无法提交；CLEANUP 通过 payload 独立执行。
    await db.documentProcessingJob.deleteMany({
      where: { documentId: id, type: { not: "CLEANUP" } },
    })
    // 分块随文档级联删除，清理任务的 documentId 外键自动置空。
    await db.knowledgeDocument.delete({ where: { id } })
    return {
      id,
      knowledgeBaseId: document.knowledgeBaseId,
      deletedAt: new Date(),
    }
  }, organizationTransactionOptions)
  return { ...deleted, cleanup: await cleanupKnowledgeResources([id]) }
}

/** 查询当前用户所有未删除的知识库，并附带有效目录数和文档数。 */
export const listKnowledgeBases = async (userId: string) =>
  prisma.knowledgeBase.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      ...knowledgeBaseSelect,
      _count: {
        select: {
          folders: { where: { deletedAt: null } },
          documents: { where: { deletedAt: null } },
        },
      },
    },
  })

/** 在当前用户账户下创建一个私有知识库。 */
export const createKnowledgeBase = async (
  userId: string,
  input: CreateKnowledgeBaseInput
) =>
  prisma.knowledgeBase.create({
    data: {
      userId,
      name: input.name,
      description: input.description,
    },
    select: knowledgeBaseSelect,
  })

/** 更新知识库名称或描述；事务锁同时避免与删除、目录写入发生竞争。 */
export const updateKnowledgeBase = async (
  userId: string,
  knowledgeBaseId: string,
  input: UpdateKnowledgeBaseInput
) =>
  prisma.$transaction(async (db) => {
    /** 更新前校验所有权，并与同一知识库的目录写入、删除操作串行执行。 */
    await lockOwnedKnowledgeBase(db, userId, knowledgeBaseId)

    return db.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: input,
      select: knowledgeBaseSelect,
    })
  }, organizationTransactionOptions)

/** 调用方持有知识库锁；普通删除和历史清理共用同一套资源登记、物理删除流程。 */
const deleteKnowledgeBaseRecords = async (
  db: KnowledgeTransaction,
  knowledgeBaseId: string
) => {
  /** 先读取文档的存储信息，供后面的任务删除和文件清理使用。 */
  const documents = await db.knowledgeDocument.findMany({
    where: { knowledgeBaseId },
    select: {
      id: true,
      knowledgeBaseId: true,
      storageKey: true,
      checksumSha256: true,
      parseMetadata: true,
      chunkStatus: true,
      updatedAt: true,
    },
  })
  const documentIds = documents.map(({ id }) => id)

  /** 先登记资源清理，再删除处理任务，阻止在途任务提交。 */
  await assertDocumentsIdle(db, documentIds)
  await registerCleanupJobs(db, documents, "knowledge-base-delete")
  await db.documentProcessingJob.deleteMany({
    where: { knowledgeBaseId, type: { not: "CLEANUP" } },
  })

  // 先删文档，再一次删除全部目录，满足 folderId 和目录父子关系的外键约束。
  const documentResult = await db.knowledgeDocument.deleteMany({
    where: { knowledgeBaseId },
  })
  const folderResult = await db.knowledgeFolder.deleteMany({
    where: { knowledgeBaseId },
  })

  /** 清理任务的 knowledgeBaseId 外键置空，payload 不受影响。 */
  await db.knowledgeBase.delete({ where: { id: knowledgeBaseId } })

  return {
    id: knowledgeBaseId,
    deletedAt: new Date(),
    folderCount: folderResult.count,
    documentCount: documentResult.count,
    documentIds,
  }
}

/** 物理删除整库；所有权校验、资源登记与数据库删除处于同一个事务。 */
export const deleteKnowledgeBase = async (
  userId: string,
  knowledgeBaseId: string
) => {
  const deleted = await prisma.$transaction(async (db) => {
    await lockOwnedKnowledgeBase(db, userId, knowledgeBaseId)
    return deleteKnowledgeBaseRecords(db, knowledgeBaseId)
  }, organizationTransactionOptions)
  return {
    ...deleted,
    cleanup: await cleanupKnowledgeResources(deleted.documentIds),
  }
}

/** 仅供一次性本地清理命令使用；不挂载 HTTP 接口，只允许清理已软删除的根节点。 */
export const purgeDeletedKnowledgeBase = async (knowledgeBaseId: string) => {
  const deleted = await prisma.$transaction(async (db) => {
    await db.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${knowledgeBaseId}, 0))::text
  `
    const deletedBase = await db.knowledgeBase.findFirst({
      where: { id: knowledgeBaseId, deletedAt: { not: null } },
      select: { id: true },
    })
    // 列出候选后可能已被其他清理进程删除；也不能误删已恢复的知识库。
    if (!deletedBase) return null

    // 旧 CLEANUP 可能已成功或重试耗尽：重新排队，不能被 dedupeKey 跳过后遗留资源。
    await db.documentProcessingJob.updateMany({
      where: {
        knowledgeBaseId,
        type: "CLEANUP",
        status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
      },
      data: {
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(Date.now() + DOCUMENT_PROCESSING_TIMEOUT_MS),
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: null,
      },
    })
    return deleteKnowledgeBaseRecords(db, knowledgeBaseId)
  }, organizationTransactionOptions)
  return deleted
    ? {
        ...deleted,
        cleanup: await cleanupKnowledgeResources(deleted.documentIds),
      }
    : null
}

/**
 * 返回构建左侧文件树所需的知识库、目录和文档摘要。
 * Repeatable Read 保证三部分来自同一个一致的数据快照。
 */
export const getKnowledgeTree = async (
  userId: string,
  knowledgeBaseId: string
) =>
  prisma.$transaction(
    async (db) => {
      /** 先校验根节点所有权，越权与不存在都会按同一种 404 处理。 */
      const knowledgeBase = await requireOwnedKnowledgeBase(
        db,
        userId,
        knowledgeBaseId
      )

      /** 目录与文档可以并行读取；Repeatable Read 保证两份结果属于同一快照。 */
      const [folders, documents] = await Promise.all([
        db.knowledgeFolder.findMany({
          where: { knowledgeBaseId, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
          select: folderSelect,
        }),
        db.knowledgeDocument.findMany({
          where: { knowledgeBaseId, deletedAt: null },
          orderBy: [{ title: "asc" }, { id: "asc" }],
          select: documentTreeSelect,
        }),
      ])

      return {
        knowledgeBase: {
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
          createdAt: knowledgeBase.createdAt,
          updatedAt: knowledgeBase.updatedAt,
        },
        folders,
        documents,
      }
    },
    { isolationLevel: "RepeatableRead" }
  )

/** 在知识库根级或指定父目录下创建文件夹。 */
export const createKnowledgeFolder = async (
  userId: string,
  knowledgeBaseId: string,
  input: CreateKnowledgeFolderInput
) =>
  prisma.$transaction(async (db) => {
    /** 锁住当前知识库，使创建目录与其他结构变更按顺序执行。 */
    await lockOwnedKnowledgeBase(db, userId, knowledgeBaseId)
    if (input.parentId) {
      /** 指定父目录时，必须确认父目录存在并且属于当前知识库。 */
      await requireFolderInKnowledgeBase(db, knowledgeBaseId, input.parentId)
    }

    return db.knowledgeFolder.create({
      data: {
        knowledgeBaseId,
        parentId: input.parentId,
        name: input.name,
        sortOrder: input.sortOrder,
      },
      select: folderSelect,
    })
  }, organizationTransactionOptions)

/**
 * 重命名、排序或移动文件夹。
 * 移动时重新校验同库父目录，并拒绝把目录放入自身或自己的后代目录。
 */
export const updateKnowledgeFolder = async (
  userId: string,
  folderId: string,
  input: UpdateKnowledgeFolderInput
) =>
  prisma.$transaction(async (db) => {
    /**
     * 先通过目录找到所属知识库，再获取这座知识库的结构锁。
     * 拿到锁后重新查询目录，确保后续校验使用的是最新已提交状态。
     */
    const initialFolder = await requireOwnedKnowledgeFolder(
      db,
      userId,
      folderId
    )
    await lockOwnedKnowledgeBase(db, userId, initialFolder.knowledgeBaseId)
    const folder = await requireOwnedKnowledgeFolder(db, userId, folderId)

    /** 只有请求明确携带 parentId 时才执行移动逻辑；单纯改名不会遍历子树。 */
    if (Object.hasOwn(input, "parentId")) {
      /** 目录直接把自己设为父目录时立即拒绝。 */
      if (input.parentId === folder.id) {
        throw knowledgeFolderCycle()
      }
      if (input.parentId) {
        /** 先排除跨知识库移动，再检查目标父目录是否位于当前目录的子树中。 */
        await requireFolderInKnowledgeBase(
          db,
          folder.knowledgeBaseId,
          input.parentId
        )
        const subtreeIds = await getFolderSubtreeIds(
          db,
          folder.knowledgeBaseId,
          folder.id
        )

        /** 目标父目录在当前子树中时，移动后会形成环，因此返回 409。 */
        if (subtreeIds.includes(input.parentId)) {
          throw knowledgeFolderCycle()
        }
      }
    }

    return db.knowledgeFolder.update({
      where: { id: folder.id },
      data: input,
      select: folderSelect,
    })
  }, organizationTransactionOptions)

/**
 * 删除目录。空目录可以直接删除；非空目录必须显式传入 recursive=true。
 * 递归物理删除子树，并在同一事务中登记资源清理、删除处理任务。
 */
export const deleteKnowledgeFolder = async (
  userId: string,
  folderId: string,
  recursive: boolean
) => {
  const deleted = await prisma.$transaction(async (db) => {
    /** 与目录移动相同：先确定所属知识库，获取结构锁后再读取最新目录。 */
    const initialFolder = await requireOwnedKnowledgeFolder(
      db,
      userId,
      folderId
    )
    await lockOwnedKnowledgeBase(db, userId, initialFolder.knowledgeBaseId)
    const folder = await requireOwnedKnowledgeFolder(db, userId, folderId)

    /** 删除范围包含当前目录以及全部后代目录。 */
    const folderIds = await getFolderSubtreeIds(
      db,
      folder.knowledgeBaseId,
      folder.id
    )

    /** 包含历史软删除文档，避免外键阻止目录删除或遗漏原件清理。 */
    const documents = await db.knowledgeDocument.findMany({
      where: {
        folderId: { in: folderIds },
      },
      select: {
        id: true,
        knowledgeBaseId: true,
        storageKey: true,
        checksumSha256: true,
        parseMetadata: true,
        chunkStatus: true,
        updatedAt: true,
      },
    })

    // 子树查询始终包含当前目录，扣除它就是后代目录数。
    const childFolderCount = folderIds.length - 1

    /** 非空目录必须由调用方显式确认递归删除，避免一次误操作删除整棵树。 */
    if (!recursive && (childFolderCount > 0 || documents.length > 0)) {
      throw knowledgeFolderNotEmpty(childFolderCount, documents.length)
    }

    const documentIds = documents.map(({ id }) => id)

    /** 先持久化资源信息，再删除文档和目录；所有步骤处于同一个事务。 */
    await assertDocumentsIdle(db, documentIds)
    await registerCleanupJobs(db, documents, "folder-delete")
    await db.documentProcessingJob.deleteMany({
      where: { documentId: { in: documentIds }, type: { not: "CLEANUP" } },
    })
    const documentResult = await db.knowledgeDocument.deleteMany({
      where: { id: { in: documentIds } },
    })
    const folderResult = await db.knowledgeFolder.deleteMany({
      where: { id: { in: folderIds } },
    })

    return {
      id: folder.id,
      deletedAt: new Date(),
      folderCount: folderResult.count,
      documentCount: documentResult.count,
      folderIds,
      documentIds,
    }
  }, organizationTransactionOptions)
  return {
    ...deleted,
    cleanup: await cleanupKnowledgeResources(deleted.documentIds),
  }
}
