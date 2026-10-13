import { beforeEach, describe, expect, it, vi } from "vitest"
import { MessageConflictError, saveMessageOnce } from "@/lib/chat/persistence"
import type { UIMessage } from "ai"

const db = vi.hoisted(() => ({
  message: { createMany: vi.fn(), findUnique: vi.fn() },
}))
vi.mock("@/lib/prisma", () => ({ default: db }))
const message: UIMessage = {
  id: "user-message",
  role: "user",
  parts: [{ type: "text", text: "如何上传？" }],
}
const chatId = "owned-chat"
const stored = {
  id: message.id,
  chatId,
  role: message.role,
  parts: message.parts,
}

beforeEach(() => {
  vi.resetAllMocks()
  db.message.createMany.mockResolvedValue({ count: 1 })
  db.message.findUnique.mockResolvedValue(stored)
})

describe("chat message persistence", () => {
  it("accepts a newly inserted tool result whose JSON score was rounded by Prisma", async () => {
    const assistant: UIMessage = {
      id: "assistant-message",
      role: "assistant",
      parts: [
        {
          type: "tool-searchKnowledge",
          toolCallId: "call-1",
          state: "output-available",
          input: { query: "如何上传？" },
          output: { items: [{ score: 1 / 65 }], warnings: [] },
        },
      ],
    }
    const rounded = JSON.parse(
      JSON.stringify(assistant.parts, (_key, value) =>
        typeof value === "number" ? Number(value.toPrecision(15)) : value
      )
    )
    expect(rounded).not.toEqual(assistant.parts)
    db.message.findUnique.mockResolvedValue({
      ...stored,
      id: assistant.id,
      role: "assistant",
      parts: rounded,
    })
    const result = await saveMessageOnce({ chatId, message: assistant })
    expect(result.created).toBe(true)
    expect(db.message.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId,
          role: "assistant",
          parts: assistant.parts,
        }),
      ],
      skipDuplicates: true,
    })
  })

  it("accepts a retry with the same ID and content without inserting again", async () => {
    db.message.createMany.mockResolvedValue({ count: 0 })
    expect((await saveMessageOnce({ chatId, message })).created).toBe(false)
  })

  it("rejects a retry that reuses a message ID with changed content", async () => {
    db.message.createMany.mockResolvedValue({ count: 0 })
    db.message.findUnique.mockResolvedValue({
      ...stored,
      parts: [{ type: "text", text: "另一条消息" }],
    })
    await expect(saveMessageOnce({ chatId, message })).rejects.toBeInstanceOf(
      MessageConflictError
    )
  })

  it.each([0, 1])(
    "still checks chat ownership and role for insert count %i",
    async (count) => {
      db.message.createMany.mockResolvedValue({ count })
      db.message.findUnique.mockResolvedValueOnce({
        ...stored,
        chatId: "other-chat",
      })
      await expect(saveMessageOnce({ chatId, message })).rejects.toBeInstanceOf(
        MessageConflictError
      )
      db.message.findUnique.mockResolvedValueOnce({
        ...stored,
        role: "assistant",
      })
      await expect(saveMessageOnce({ chatId, message })).rejects.toBeInstanceOf(
        MessageConflictError
      )
    }
  )

  it("rejects a message that cannot be read back after insertion", async () => {
    db.message.findUnique.mockResolvedValue(null)
    await expect(saveMessageOnce({ chatId, message })).rejects.toBeInstanceOf(
      MessageConflictError
    )
  })
})
