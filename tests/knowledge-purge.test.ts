import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { db, purge } = vi.hoisted(() => ({
  db: { knowledgeBase: { findMany: vi.fn() }, $disconnect: vi.fn() },
  purge: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ default: db }))
vi.mock("@/lib/knowledge/management/service", () => ({
  purgeDeletedKnowledgeBase: purge,
}))

const originalArgv = process.argv
const base = {
  id: "old-base",
  name: "历史库",
  deletedAt: new Date(),
  _count: { documents: 2, folders: 1 },
}
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  process.argv = [originalArgv[0], "purge-deleted-knowledge.ts"]
  vi.spyOn(console, "table").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
  db.knowledgeBase.findMany.mockResolvedValue([base])
  purge.mockResolvedValue({ documentCount: 2, folderCount: 1 })
})
afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
})

describe("historical knowledge purge command", () => {
  it("previews only soft-deleted roots by default without invoking deletion", async () => {
    await import("@/workers/purge-deleted-knowledge")
    expect(db.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: { not: null } } })
    )
    expect(console.table).toHaveBeenCalledWith([
      expect.objectContaining({ id: base.id, documents: 2, folders: 1 }),
    ])
    expect(purge).not.toHaveBeenCalled()
    expect(db.$disconnect).toHaveBeenCalledOnce()
  })

  it("restricts execution to the specified historical base", async () => {
    process.argv.push("--execute", "--id=old-base")
    await import("@/workers/purge-deleted-knowledge")
    expect(db.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old-base", deletedAt: { not: null } },
      })
    )
    expect(purge).toHaveBeenCalledExactlyOnceWith(base.id)
    expect(db.$disconnect).toHaveBeenCalledOnce()
  })

  it("executes all listed soft-deleted roots when no id is provided", async () => {
    process.argv.push("--execute")
    db.knowledgeBase.findMany.mockResolvedValue([
      base,
      { ...base, id: "second-base" },
    ])
    await import("@/workers/purge-deleted-knowledge")
    expect(purge.mock.calls).toEqual([["old-base"], ["second-base"]])
  })

  it("does not invoke deletion if the candidate list is empty", async () => {
    process.argv.push("--execute")
    db.knowledgeBase.findMany.mockResolvedValue([])
    await import("@/workers/purge-deleted-knowledge")
    expect(purge).not.toHaveBeenCalled()
  })

  it("surfaces deletion failures and closes the database connection", async () => {
    process.argv.push("--execute")
    purge.mockRejectedValue(new Error("cleanup registration failed"))
    await expect(import("@/workers/purge-deleted-knowledge")).rejects.toThrow(
      "cleanup registration failed"
    )
    expect(db.$disconnect).toHaveBeenCalledOnce()
  })
})
