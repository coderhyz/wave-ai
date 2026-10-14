import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { agentRoute } from "@/app/api/[[...route]]/agent"
import { chatModels, type ChatModelId } from "@/lib/ai/model"
import { getModelGenerationSettings } from "@/lib/ai/generation-settings"
import { toUIMessage } from "@/lib/chat/mapper"

const mocks = vi.hoisted(() => ({
  session: vi.fn(), model: vi.fn(), fetch: vi.fn<typeof fetch>(), cleanup: vi.fn(),
  db: {
    chat: { createMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    message: { createMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    chatAttachment: { findMany: vi.fn() },
  },
}))
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock("@/lib/prisma", () => ({ default: mocks.db }))
vi.mock("@/lib/chat-attachment-storage", () => ({ deleteOssObjectsBestEffort: mocks.cleanup }))
vi.mock("@/lib/ai/provider", () => ({
  myProvider: { languageModel: mocks.model },
  getChatGenerationSettings: (id: ChatModelId) => {
    const model = chatModels.find((item) => item.id === id)
    if (!model) throw new Error("Unknown test model")
    return getModelGenerationSettings(model)
  },
}))

const chatId = "10000000-0000-4000-8000-000000000001"
type StoredMessage = Parameters<typeof toUIMessage>[0] & { chatId: string }
let stored: StoredMessage[]
const result = { title: "官方文档", url: "https://example.test/docs", content: "这是搜索摘要" }
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}
function step(parts: LanguageModelV4StreamPart[], toolCall = false) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        for (const part of parts) controller.enqueue(part)
        controller.enqueue({ type: "finish", usage, finishReason: {
          unified: toolCall ? "tool-calls" : "stop", raw: undefined,
        } })
        controller.close()
      },
    }),
  }
}
function useModel(calls = 1) {
  const model = new MockLanguageModelV4({ doStream: [
    step(Array.from({ length: calls }, (_, index) => ({
      type: "tool-call" as const, toolName: "webSearch", toolCallId: `call-${index}`,
      input: JSON.stringify({ query: "官方 API 文档", maxResults: 10 }),
    })), true),
    step([
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "根据本次搜索摘要，结论如下。" },
      { type: "text-end", id: "answer" },
    ]),
  ] })
  mocks.model.mockReturnValue(model)
  return model
}
function send(overrides: Record<string, unknown> = {}, signal?: AbortSignal) {
  return agentRoute.request("/runs", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({
      id: chatId, selectedModelId: "qwen-plus", trigger: "submit-message",
      message: { id: "user-1", role: "user", parts: [{ type: "text", text: "查询官方 API 文档" }] },
      ...overrides,
    }),
  })
}
async function read(response: Response) {
  expect(response.status).toBe(200)
  const text = await response.text()
  await vi.waitFor(() => expect(stored.at(-1)?.role).toBe("assistant"))
  return text
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("TAVILY_API_KEY", "test-key")
  vi.stubGlobal("fetch", mocks.fetch)
  stored = []
  mocks.session.mockResolvedValue({ user: { id: "owner" } })
  mocks.db.chat.createMany.mockResolvedValue({ count: 1 })
  mocks.db.chat.findUnique.mockResolvedValue({ id: chatId, userId: "owner", modelId: "qwen-plus" })
  mocks.db.chat.updateMany.mockResolvedValue({ count: 1 })
  mocks.db.message.createMany.mockImplementation(async ({ data }) => {
    const row = data[0]
    if (stored.some((message) => message.id === row.id)) return { count: 0 }
    stored.push({ metadata: null, modelId: null, finishReason: null,
      promptTokens: null, completionTokens: null, ...JSON.parse(JSON.stringify(row)), createdAt: new Date() })
    return { count: 1 }
  })
  mocks.db.message.findUnique.mockImplementation(async ({ where }) => stored.find((row) => row.id === where.id))
  mocks.db.message.findMany.mockImplementation(async () => [...stored])
  mocks.db.message.deleteMany.mockImplementation(async ({ where }) => {
    stored = stored.filter((row) => !where.id.in.includes(row.id))
    return { count: 1 }
  })
  mocks.db.chatAttachment.findMany.mockResolvedValue([])
  mocks.fetch.mockResolvedValue(Response.json({ results: [result] }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("minimal web research", () => {
  it("searches once, streams and persists sources, and restores the same message", async () => {
    const model = useModel()
    const sse = await read(await send())
    expect(sse).toContain('"type":"source-url"')
    expect(sse).not.toContain('"type":"error"')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(mocks.fetch.mock.calls[0][1]?.body))).toMatchObject({ max_results: 5 })
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doStreamCalls[0].toolChoice).toMatchObject({ type: "tool", toolName: "webSearch" })
    expect(model.doStreamCalls[1].toolChoice).toEqual({ type: "none" })
    const message = toUIMessage(stored.at(-1)!)
    expect(message.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "source-url", url: result.url, title: result.title }),
      expect.objectContaining({ type: "tool-webSearch", state: "output-available" }),
    ]))
    expect(message.metadata).toMatchObject({ mode: "web" })
    expect(stored.at(-1)?.promptTokens).toBe(20)
  })
  it("enforces the request budget even for parallel tool calls", async () => {
    useModel(2)
    await read(await send())
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(stored.at(-1)?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: { success: false, error: "本轮只允许一次联网搜索" } }),
    ]))
  })
  it("deduplicates URLs and keeps source identifiers in history", async () => {
    useModel()
    mocks.fetch.mockResolvedValue(Response.json({ results: [result, { ...result, url: `${result.url}#section` }] }))
    await read(await send())
    const sources = toUIMessage(stored.at(-1)!).parts.filter((part) => part.type === "source-url")
    expect(sources).toHaveLength(1)
    expect(sources[0].sourceId).toBeTruthy()
  })
  it.each(["empty", "http", "config", "malformed"])("distinguishes %s search results without inventing sources", async (kind) => {
    useModel()
    if (kind === "empty") mocks.fetch.mockResolvedValue(Response.json({ results: [] }))
    if (kind === "http") mocks.fetch.mockResolvedValue(new Response("unavailable", { status: 429 }))
    if (kind === "config") vi.stubEnv("TAVILY_API_KEY", undefined)
    if (kind === "malformed") mocks.fetch.mockResolvedValue(Response.json({ results: [{ ...result, url: "javascript:alert(1)" }] }))
    await read(await send())
    const parts = toUIMessage(stored.at(-1)!).parts
    expect(parts.some((part) => part.type === "source-url")).toBe(false)
    expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "tool-webSearch", output: expect.objectContaining({ success: kind === "empty" }),
    })]))
    if (kind === "config") expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it("rejects unauthenticated and cross-user access before model or search calls", async () => {
    mocks.session.mockResolvedValueOnce(null)
    expect((await send()).status).toBe(401)
    mocks.db.chat.findUnique.mockResolvedValue({ id: chatId, userId: "someone-else" })
    expect((await send()).status).toBe(404)
    expect(mocks.model).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(stored).toHaveLength(0)
  })
  it("rejects file inputs and fixed document-chat scopes", async () => {
    expect((await send({ message: { id: "file", role: "user", parts: [{ type: "file", url: "https://example.test/a.pdf", mediaType: "application/pdf" }] } })).status).toBe(400)
    mocks.db.chat.findUnique.mockResolvedValue({ id: chatId, userId: "owner", modelId: "qwen-plus", documentId: chatId })
    expect((await send()).status).toBe(409)
    expect(mocks.model).not.toHaveBeenCalled()
  })
  it("regenerates without duplicating the user message and cleans removed attachments", async () => {
    useModel()
    await read(await send())
    mocks.db.chatAttachment.findMany.mockResolvedValue([{ storageKey: "removed-key" }])
    useModel()
    await read(await send({ trigger: "regenerate-message" }))
    expect(stored).toHaveLength(2)
    expect(mocks.cleanup).toHaveBeenCalledWith(["removed-key"])
    expect(toUIMessage(stored[0]).metadata).toMatchObject({ mode: "web" })
  })
  it("aborts an in-flight search and persists its interrupted tool state", async () => {
    useModel()
    const controller = new AbortController()
    mocks.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    const response = await send({}, controller.signal)
    const reading = read(response)
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    controller.abort()
    await reading
    expect(mocks.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(toUIMessage(stored.at(-1)!).metadata).toMatchObject({ isAborted: true })
  })
})
