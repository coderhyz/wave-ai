import { parseArgs } from "node:util"
import prisma from "@/lib/prisma"
import { purgeDeletedKnowledgeBase } from "@/lib/knowledge/management/service"

// 默认只预览；--execute 才修改数据库，--id 可限定为一个历史知识库。
const { values } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    id: { type: "string" },
  },
})

try {
  const bases = await prisma.knowledgeBase.findMany({
    where: {
      deletedAt: { not: null },
      ...(values.id ? { id: values.id } : {}),
    },
    select: {
      id: true,
      name: true,
      deletedAt: true,
      _count: { select: { documents: true, folders: true } },
    },
    orderBy: { deletedAt: "asc" },
  })
  console.table(
    bases.map((base) => ({
      id: base.id,
      name: base.name,
      deletedAt: base.deletedAt,
      documents: base._count.documents,
      folders: base._count.folders,
    }))
  )
  if (!values.execute) {
    console.log("仅预览，未修改数据。加 --execute 执行，或用 --id 指定知识库。")
  } else {
    for (const base of bases) {
      const deleted = await purgeDeletedKnowledgeBase(base.id)
      if (deleted)
        console.log(
          `已清除 ${base.id}：${deleted.documentCount} 个文档，${deleted.folderCount} 个目录。`
        )
    }
    console.log(
      "数据库清理完成。请运行文档 Worker 清理 OSS 和 ES；ES 清理默认延迟约 10 分钟。"
    )
  }
} finally {
  await prisma.$disconnect()
}
