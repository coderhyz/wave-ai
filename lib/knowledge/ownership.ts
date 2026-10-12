/** 知识库所有权与文件夹归属校验，统一阻止跨用户、跨知识库访问。 */
import type { Prisma } from "@/app/generated/prisma"
import {
  knowledgeBaseNotFound,
  knowledgeFolderNotFound,
} from "@/lib/knowledge/errors"

/** 知识库 service 在 Prisma 交互式事务中使用的数据库客户端类型。 */
export type KnowledgeTransaction = Prisma.TransactionClient

/** 查找当前用户仍有效的知识库；越权访问与不存在统一返回 404。 */
export const requireOwnedKnowledgeBase = async (
  db: KnowledgeTransaction,
  userId: string,
  knowledgeBaseId: string
) => {
  /** userId 来自登录态，不从请求 JSON 中读取；deletedAt 过滤已经软删除的数据。 */
  const knowledgeBase = await db.knowledgeBase.findFirst({
    where: {
      id: knowledgeBaseId,
      userId,
      deletedAt: null,
    },
  })

  if (!knowledgeBase) {
    throw knowledgeBaseNotFound()
  }

  return knowledgeBase
}

/**
 * 按知识库获取事务级咨询锁。所有目录结构写操作共用这把锁，从而串行检查父子关系，
 * 防止两个并发移动分别通过检查后共同形成环。
 */
export const lockOwnedKnowledgeBase = async (
  db: KnowledgeTransaction,
  userId: string,
  knowledgeBaseId: string
) => {
  /**
   * UUID 会被稳定转换成 bigint 锁键。同一个知识库得到同一把事务锁，
   * 锁会在事务提交或回滚时由 PostgreSQL 自动释放。
   */
  await db.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${knowledgeBaseId}, 0))::text
  `

  /** 获取锁后重新检查所有权，避免等待期间知识库已经被其他事务删除。 */
  await requireOwnedKnowledgeBase(db, userId, knowledgeBaseId)
}

/** 文件夹所有权通过所属知识库的 userId 判断，不接受客户端 userId。 */
export const requireOwnedKnowledgeFolder = async (
  db: KnowledgeTransaction,
  userId: string,
  folderId: string
) => {
  /** 通过 knowledgeBase.userId 一次完成目录有效性和所属用户检查。 */
  const folder = await db.knowledgeFolder.findFirst({
    where: {
      id: folderId,
      deletedAt: null,
      knowledgeBase: {
        userId,
        deletedAt: null,
      },
    },
  })

  if (!folder) {
    throw knowledgeFolderNotFound()
  }

  return folder
}

/** 目标父目录必须存在、未删除并且与当前目录属于同一个知识库。 */
export const requireFolderInKnowledgeBase = async (
  db: KnowledgeTransaction,
  knowledgeBaseId: string,
  folderId: string
) => {
  /** 这里同时比较 knowledgeBaseId，因此其他知识库中的目录不能成为目标父目录。 */
  const folder = await db.knowledgeFolder.findFirst({
    where: {
      id: folderId,
      knowledgeBaseId,
      deletedAt: null,
    },
  })

  if (!folder) {
    throw knowledgeFolderNotFound()
  }

  return folder
}
