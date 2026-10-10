import type { Prisma } from "@/app/generated/prisma"
import prisma from "@/lib/prisma"
import {
  knowledgeFolderCycle,
  knowledgeFolderNotEmpty,
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
  source: true,
  status: true,
  revision: true,
  contentRevision: true,
  chunkStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeDocumentSelect

/**
 * 从指定目录开始，按层收集仍有效的整棵子树 ID。
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
        deletedAt: null,
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

/** 删除文档前取消尚未结束的解析、重解析和分块任务。 */
const cancelDocumentJobs = async (
  db: KnowledgeTransaction,
  documentIds: string[]
) => {
  if (documentIds.length === 0) return

  /** CLEANUP 任务不能取消，否则已经登记的原文件将无法被后续 Worker 回收。 */
  await db.documentProcessingJob.updateMany({
    where: {
      documentId: { in: documentIds },
      type: { in: ["PARSE", "REPARSE", "RECHUNK"] },
      status: { in: ["PENDING", "RUNNING"] },
    },
    data: {
      status: "CANCELLED",
      lockedAt: null,
      lockedUntil: null,
      lockToken: null,
    },
  })
}

/**
 * 为带原文件的文档登记清理任务。
 * payload 独立保存 storageKey，后续即使文档被物理删除，Worker 仍能清理文件。
 */
const registerCleanupJobs = async (
  db: KnowledgeTransaction,
  documents: Array<{
    id: string
    knowledgeBaseId: string
    storageKey: string | null
    checksumSha256: string | null
  }>,
  reason: "knowledge-base-delete" | "folder-delete"
) => {
  /** 手动文档没有 storageKey，因此不需要创建原文件清理任务。 */
  const jobs = documents.flatMap((document) =>
    document.storageKey
      ? [
          {
            knowledgeBaseId: document.knowledgeBaseId,
            documentId: document.id,
            type: "CLEANUP" as const,
            status: "PENDING" as const,
            dedupeKey: `cleanup:${document.id}:${document.checksumSha256 ?? document.storageKey}`,
            payload: {
              storageKey: document.storageKey,
              documentId: document.id,
              reason,
            } satisfies Prisma.InputJsonObject,
          },
        ]
      : []
  )

  if (jobs.length > 0) {
    /** dedupeKey 配合 skipDuplicates，避免重复删除请求生成相同清理任务。 */
    await db.documentProcessingJob.createMany({
      data: jobs,
      skipDuplicates: true,
    })
  }
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

/**
 * 软删除整个知识库及其目录和文档。
 * 同一事务中还会取消处理任务，并为已有原文件登记后续清理任务。
 */
export const deleteKnowledgeBase = async (
  userId: string,
  knowledgeBaseId: string
) =>
  prisma.$transaction(async (db) => {
    /** 第一步：锁住知识库，同时确认它属于当前登录用户且尚未删除。 */
    await lockOwnedKnowledgeBase(db, userId, knowledgeBaseId)
    const deletedAt = new Date()

    /** 第二步：先读取文档的存储信息，供后面的任务取消和文件清理使用。 */
    const documents = await db.knowledgeDocument.findMany({
      where: { knowledgeBaseId, deletedAt: null },
      select: {
        id: true,
        knowledgeBaseId: true,
        storageKey: true,
        checksumSha256: true,
      },
    })
    const documentIds = documents.map(({ id }) => id)

    /** 第三步：停止仍在处理的文档，并为有原文件的文档登记清理任务。 */
    await cancelDocumentJobs(db, documentIds)
    await registerCleanupJobs(db, documents, "knowledge-base-delete")

    /** 第四步：目录和文档只写 deletedAt，保留数据用于审计及后续清理。 */
    const [folderResult, documentResult] = await Promise.all([
      db.knowledgeFolder.updateMany({
        where: { knowledgeBaseId, deletedAt: null },
        data: { deletedAt },
      }),
      db.knowledgeDocument.updateMany({
        where: { knowledgeBaseId, deletedAt: null },
        data: { deletedAt, revision: { increment: 1 } },
      }),
    ])

    /** 最后软删除知识库根节点；以上任一步失败都会使整个事务回滚。 */
    await db.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: { deletedAt },
    })

    return {
      id: knowledgeBaseId,
      deletedAt,
      folderCount: folderResult.count,
      documentCount: documentResult.count,
    }
  }, organizationTransactionOptions)

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
 * 递归删除采用软删除，并同步处理子树中文档的任务取消与文件清理登记。
 */
export const deleteKnowledgeFolder = async (
  userId: string,
  folderId: string,
  recursive: boolean
) =>
  prisma.$transaction(async (db) => {
    /** 与目录移动相同：先确定所属知识库，获取结构锁后再读取最新目录。 */
    const initialFolder = await requireOwnedKnowledgeFolder(
      db,
      userId,
      folderId
    )
    await lockOwnedKnowledgeBase(db, userId, initialFolder.knowledgeBaseId)
    const folder = await requireOwnedKnowledgeFolder(db, userId, folderId)

    /** 删除范围包含当前目录以及它下面所有仍未删除的后代目录。 */
    const folderIds = await getFolderSubtreeIds(
      db,
      folder.knowledgeBaseId,
      folder.id
    )

    /** 找出子树中的有效文档，后续需要一起软删除并处理后台任务。 */
    const documents = await db.knowledgeDocument.findMany({
      where: {
        folderId: { in: folderIds },
        deletedAt: null,
      },
      select: {
        id: true,
        knowledgeBaseId: true,
        storageKey: true,
        checksumSha256: true,
      },
    })

    const childFolderCount = Math.max(0, folderIds.length - 1)

    /** 非空目录必须由调用方显式确认递归删除，避免一次误操作删除整棵树。 */
    if (!recursive && (childFolderCount > 0 || documents.length > 0)) {
      throw knowledgeFolderNotEmpty(childFolderCount, documents.length)
    }

    const deletedAt = new Date()
    const documentIds = documents.map(({ id }) => id)

    /** 先处理后台任务，再软删除目录和文档；所有步骤处于同一个事务。 */
    await cancelDocumentJobs(db, documentIds)
    await registerCleanupJobs(db, documents, "folder-delete")
    const [folderResult, documentResult] = await Promise.all([
      db.knowledgeFolder.updateMany({
        where: { id: { in: folderIds }, deletedAt: null },
        data: { deletedAt },
      }),
      db.knowledgeDocument.updateMany({
        where: { id: { in: documentIds }, deletedAt: null },
        data: { deletedAt, revision: { increment: 1 } },
      }),
    ])

    return {
      id: folder.id,
      deletedAt,
      folderCount: folderResult.count,
      documentCount: documentResult.count,
    }
  }, organizationTransactionOptions)
