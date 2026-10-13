import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { UIMessage } from "ai"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { chatModels, type ChatModelId } from "@/lib/ai/model"
import { getModelGenerationSettings } from "@/lib/ai/generation-settings"
import { chatRoute } from "@/app/api/[[...route]]/chat"
import { getKnowledgeCitations } from "@/lib/chat/citations"
import { toUIMessage } from "@/lib/chat/mapper"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  search: vi.fn(),
  weather: vi.fn(),
  web: vi.fn(),
  languageModel: vi.fn(),
  db: {
    chat: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    message: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    chatAttachment: { findMany: vi.fn() },
    knowledgeDocument: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}))
vi.mock("@/lib/prisma", () => ({ default: mocks.db }))
vi.mock("@/lib/ai/provider", () => ({
  myProvider: { languageModel: mocks.languageModel },
  getChatGenerationSettings: (id: ChatModelId) => {
    const model = chatModels.find((item) => item.id === id)
    if (!model) throw new Error("Unknown test model")
    return getModelGenerationSettings(model)
  },
}))
vi.mock("@/lib/knowledge/retrieval/search", () => ({
  searchKnowledge: mocks.search,
}))
vi.mock("@/lib/chat-attachment-preparer", () => ({
  createStoredAttachmentPreparer: () => async (messages: UIMessage[]) =>
    messages,
}))
vi.mock("@/lib/chat-attachment-storage", () => ({
  createStoredAttachmentResolver: vi.fn(),
  claimMessageAttachments: vi.fn(),
  deleteOssObjectsBestEffort: vi.fn(),
  deletePendingChatAttachment: vi.fn(),
  readOwnedChatAttachment: vi.fn(),
  uploadChatAttachment: vi.fn(),
}))

vi.mock("@/lib/ai/tool/weather", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/tool/weather")>()
  return { getWeather: { ...actual.getWeather, execute: mocks.weather } }
})
vi.mock("@/lib/ai/tool/web-search", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/tool/web-search")>()
  return { webSearch: { ...actual.webSearch, execute: mocks.web } }
})

const chatId = "10000000-0000-4000-8000-000000000001"
const documentId = "20000000-0000-4000-8000-000000000002"
const knowledgeBaseId = "30000000-0000-4000-8000-000000000003"
const modelId = "deepseek-v4-pro"
const user = { id: "owner", email: "owner@example.com", name: "owner" }
const retrieval = {
  items: [
    {
      chunkId: "chunk-1",
      documentId,
      knowledgeBaseId,
      documentTitle: "上传指南",
      content: "点击上传按钮",
      contentRevision: 2,
      chunkIndex: 0,
    },
  ],
  warnings: [],
}
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
type StoredMessage = Parameters<typeof toUIMessage>[0] & { chatId: string }
let stored: StoredMessage[]

const streamStep = (
  content: LanguageModelV4StreamPart[],
  toolCall = false
) => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      for (const part of content) controller.enqueue(part)
      controller.enqueue({
        type: "finish",
        usage,
        finishReason: {
          unified: toolCall ? "tool-calls" : "stop",
          raw: undefined,
        },
      })
      controller.close()
    },
  }),
})
const searchStep = (query = "如何上传", id = "call-1") =>
  streamStep(
    [
      {
        type: "tool-call",
        toolName: "searchKnowledge",
        toolCallId: id,
        input: JSON.stringify({ query }),
      },
    ],
    true
  )
const answerStep = (
  text = "点击上传按钮。来源：上传指南（chunkId: chunk-1）"
) =>
  streamStep([
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
  ])
const useModel = (...steps: ReturnType<typeof streamStep>[]) => {
  const model = new MockLanguageModelV4({ doStream: steps })
  mocks.languageModel.mockReturnValue(model)
  return model
}
const send = (
  id = "user-1",
  trigger = "submit-message",
  scopeDocumentId?: string,
  selectedModelId: ChatModelId = modelId,
  text = "根据知识库，如何上传？"
) =>
  chatRoute.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      documentId: scopeDocumentId,
      message: {
        id,
        role: "user",
        parts: [{ type: "text", text }],
      },
      selectedModelId,
      selectedToolName: null,
      trigger,
    }),
  })
const readResponse = async (response: Response) => {
  expect(response.status).toBe(200)
  const sse = await response.text()
  expect(sse).toContain("[DONE]")
  expect(sse).not.toContain('"type":"error"')
  // SSE 的持久化回调由后台消费，等待实际写入完成。
  await vi.waitFor(() => expect(stored.at(-1)?.role).toBe("assistant"))
  return sse
}

beforeEach(() => {
  vi.resetAllMocks()
  stored = []
  mocks.getSession.mockResolvedValue({ user })
  mocks.search.mockResolvedValue(retrieval)
  mocks.db.chat.createMany.mockResolvedValue({ count: 1 })
  mocks.db.chat.findUnique.mockResolvedValue({
    id: chatId,
    userId: user.id,
    modelId,
  })
  mocks.db.knowledgeDocument.findFirst.mockResolvedValue({
    id: documentId,
    status: "READY",
    chunkStatus: "READY",
    contentRevision: 2,
    chunkedContentRevision: 2,
  })
  mocks.db.chat.findFirst.mockResolvedValue(null)
  mocks.db.chat.findMany.mockResolvedValue([])
  mocks.db.chat.updateMany.mockResolvedValue({ count: 1 })
  mocks.db.message.createMany.mockImplementation(async ({ data }) => {
    const row = data[0]
    if (stored.some((message) => message.id === row.id)) return { count: 0 }
    stored.push({
      metadata: null,
      modelId: null,
      finishReason: null,
      promptTokens: null,
      completionTokens: null,
      ...JSON.parse(JSON.stringify(row)),
      createdAt: new Date(),
    })
    return { count: 1 }
  })
  mocks.db.message.findUnique.mockImplementation(async ({ where }) =>
    stored.find((row) => row.id === where.id)
  )
  mocks.db.message.findMany.mockImplementation(async () => [...stored])
  mocks.db.message.deleteMany.mockImplementation(async ({ where }) => {
    stored = stored.filter((row) => !where.id.in.includes(row.id))
  })
  mocks.db.chatAttachment.findMany.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const externalStep = (
  toolName: "getWeather" | "webSearch" | "listKnowledgeDocuments",
  input: unknown
) =>
  streamStep(
    [
      {
        type: "tool-call",
        toolName,
        toolCallId: "external-call",
        input: JSON.stringify(input),
      },
    ],
    true
  )

const webResult = {
  success: true,
  query: "AI SDK 文档",
  source: "Tavily",
  results: [
    {
      id: 1,
      title: "AI SDK 文档",
      url: "https://ai-sdk.dev/docs",
      snippet: "工具调用文档",
      score: 0.9,
      publishedAt: null,
    },
  ],
}
const weatherResult = {
  success: true,
  source: "Open-Meteo",
  timezone: "Asia/Shanghai",
  location: { city: "北京", region: "北京", country: "中国" },
  current: { time: "2026-10-13T20:00", temperature: 19 },
  forecast: [],
  units: { temperature: "°C" },
}

describe("ordinary chat external tools", () => {
  it.each([
    {
      name: "webSearch" as const,
      input: { query: "AI SDK 文档" },
      result: webResult,
      question: "查一下 AI SDK 官方文档",
    },
    {
      name: "getWeather" as const,
      input: { city: "北京" },
      result: weatherResult,
      question: "北京现在天气如何？",
    },
  ])(
    "executes $name, continues answering, persists its result and restores history",
    async ({ name, input, result, question }) => {
      const execute = name === "webSearch" ? mocks.web : mocks.weather
      execute.mockResolvedValueOnce(result)
      const model = useModel(
        externalStep(name, input),
        answerStep("已根据查询结果回答。")
      )
      const sse = await readResponse(
        await send("user-1", "submit-message", undefined, modelId, question)
      )
      expect(model.doStreamCalls[0].tools?.map((item) => item.name)).toEqual(
        expect.arrayContaining(["searchKnowledge", "webSearch", "getWeather"])
      )
      expect(execute).toHaveBeenCalledWith(
        input,
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
      )
      expect(mocks.search).not.toHaveBeenCalled()
      expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
        JSON.stringify(result)
      )
      expect(sse).toContain('"type":"tool-output-available"')
      expect(stored.at(-1)?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-" + name,
            state: "output-available",
            output: result,
          }),
        ])
      )
      expect(stored.at(-1)?.metadata).toMatchObject({ citationChunkIds: [] })
      const followup = useModel(answerStep("继续解释前面的结果。"))
      await readResponse(
        await send(
          "user-2",
          "submit-message",
          undefined,
          modelId,
          "解释一下前面的结果"
        )
      )
      expect(JSON.stringify(followup.doStreamCalls[0].prompt)).toContain(
        JSON.stringify(result)
      )
      expect(execute).toHaveBeenCalledOnce()
    }
  )

  it("preserves an external tool failure for the model and history", async () => {
    const failure = { success: false, error: "服务端未配置 TAVILY_API_KEY" }
    mocks.web.mockResolvedValueOnce(failure)
    const model = useModel(
      externalStep("webSearch", { query: "最新信息" }),
      answerStep("本次无法完成联网查询。")
    )
    await readResponse(await send())
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      JSON.stringify(failure)
    )
    expect(stored.at(-1)?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ output: failure })])
    )
  })

  it.each(["getWeather", "webSearch"] as const)(
    "does not expose or execute %s in document preview chat",
    async (name) => {
      mocks.db.chat.findUnique.mockResolvedValue({
        id: chatId,
        userId: user.id,
        modelId,
        documentId,
      })
      const input =
        name === "getWeather" ? { city: "北京" } : { query: "公开资料" }
      const model = useModel(
        externalStep(name, input),
        answerStep("文档问答仅依据当前文档。")
      )
      vi.spyOn(console, "error").mockImplementation(() => {})
      const response = await send("user-1", "submit-message", documentId)
      expect(response.status).toBe(200)
      const sse = await response.text()
      expect(sse).toContain("[DONE]")
      expect(sse).toContain('"type":"tool-input-error"')
      await vi.waitFor(() => expect(stored.at(-1)?.role).toBe("assistant"))
      expect(model.doStreamCalls[0].tools?.map((item) => item.name)).toEqual([
        "searchKnowledge",
      ])
      expect(mocks.weather).not.toHaveBeenCalled()
      expect(mocks.web).not.toHaveBeenCalled()
    }
  )
})

describe("ordinary chat RAG", () => {
  it("sends compatible DeepSeek HTTP parameters for forced retrieval, then restores thinking for the answer", async () => {
    mocks.db.chat.findUnique.mockResolvedValue({
      id: chatId,
      userId: user.id,
      modelId,
      documentId,
    })
    const requests: Record<string, unknown>[] = []
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      if (
        body.thinking?.type === "enabled" &&
        typeof body.tool_choice === "object"
      ) {
        return Response.json(
          {
            error: {
              message: "Thinking mode does not support this tool_choice",
            },
          },
          { status: 400 }
        )
      }
      const searching = requests.length === 1
      const delta = searching
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: {
                  name: "searchKnowledge",
                  arguments: JSON.stringify({ query: "如何上传" }),
                },
              },
            ],
          }
        : { content: "点击上传按钮。来源：上传指南（chunkId: chunk-1）" }
      const events = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: searching ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      return new Response(
        events
          .map((event) => "data: " + JSON.stringify(event) + "\n\n")
          .join("") + "data: [DONE]\n\n",
        {
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    })
    mocks.languageModel.mockReturnValue(
      createDeepSeek({ apiKey: "test", fetch: fetchMock })(modelId)
    )
    await readResponse(await send("user-1", "submit-message", documentId))
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      thinking: { type: "disabled" },
      tool_choice: { type: "function", function: { name: "searchKnowledge" } },
    })
    expect(requests[0]).not.toHaveProperty("reasoning_effort")
    expect(requests[1]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
      tool_choice: "auto",
    })
    expect(mocks.search).toHaveBeenCalledOnce()
    expect(stored.at(-1)?.metadata).toMatchObject({
      citationChunkIds: ["chunk-1"],
    })
  })

  it.each(["qwen-plus", "qwen3.7-flash"] as const)(
    "preserves %s settings when forcing document retrieval",
    async (selectedModelId) => {
      mocks.db.chat.findUnique.mockResolvedValue({
        id: chatId,
        userId: user.id,
        modelId: selectedModelId,
        documentId,
      })
      const model = useModel(searchStep(), answerStep())
      await readResponse(
        await send("user-1", "submit-message", documentId, selectedModelId)
      )
      expect(model.doStreamCalls[0].toolChoice).toEqual({
        type: "tool",
        toolName: "searchKnowledge",
      })
      const settings = chatModels.find((item) => item.id === selectedModelId)
      if (!settings) throw new Error("Unknown test model")
      expect(model.doStreamCalls[0].providerOptions).toEqual(
        getModelGenerationSettings(settings).providerOptions
      )
    }
  )

  it("binds preview retrieval to the document stored on the chat and saves citations", async () => {
    mocks.db.chat.findUnique.mockResolvedValue({
      id: chatId,
      userId: user.id,
      modelId,
      documentId,
    })
    const model = useModel(
      searchStep(),
      answerStep("点击上传按钮。[上传指南](knowledge://document/" + documentId + ")")
    )
    await readResponse(await send("user-1", "submit-message", documentId))
    expect(model.doStreamCalls[0].toolChoice).toEqual({
      type: "tool",
      toolName: "searchKnowledge",
    })
    expect(mocks.db.chat.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ documentId })],
      })
    )
    expect(mocks.search.mock.calls[0][1]).toMatchObject({ documentId })
    const saved = stored.at(-1)
    expect(saved?.metadata).toMatchObject({ citationChunkIds: ["chunk-1"] })
    if (!saved) throw new Error("Expected saved answer")
    mocks.db.chat.findFirst.mockResolvedValue({
      id: chatId,
      documentId,
      messages: stored,
    })
    const response = await chatRoute.request("/documents/" + documentId)
    expect(response.status).toBe(200)
    const history = await response.json()
    expect(history.chat.documentId).toBe(documentId)
    expect(getKnowledgeCitations(history.messages[1])).toEqual(retrieval.items)
    expect(mocks.db.chat.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: user.id, documentId },
      })
    )
  })

  it.each([undefined, "40000000-0000-4000-8000-000000000004"])(
    "cannot widen or change a persisted document chat scope: %s",
    async (requested) => {
      mocks.db.chat.findUnique.mockResolvedValue({
        id: chatId,
        userId: user.id,
        modelId,
        documentId,
      })
      expect((await send("user-1", "submit-message", requested)).status).toBe(
        409
      )
      expect(mocks.languageModel).not.toHaveBeenCalled()
      expect(mocks.search).not.toHaveBeenCalled()
      expect(mocks.db.message.createMany).not.toHaveBeenCalled()
    }
  )

  it("cannot reuse an ordinary chat as a document chat", async () => {
    expect((await send("user-1", "submit-message", documentId)).status).toBe(
      409
    )
    expect(mocks.db.message.createMany).not.toHaveBeenCalled()
    expect(mocks.languageModel).not.toHaveBeenCalled()
  })

  it.each([
    { status: "PARSING", chunkStatus: "PENDING", chunkedContentRevision: 2 },
    { status: "READY", chunkStatus: "FAILED", chunkedContentRevision: 2 },
    { status: "READY", chunkStatus: "READY", chunkedContentRevision: 1 },
  ])(
    "does not generate before the current document index is ready: %j",
    async (state) => {
      mocks.db.knowledgeDocument.findFirst.mockResolvedValue({
        id: documentId,
        contentRevision: 2,
        ...state,
      })
      expect((await send("user-1", "submit-message", documentId)).status).toBe(
        409
      )
      expect(mocks.db.chat.createMany).not.toHaveBeenCalled()
      expect(mocks.languageModel).not.toHaveBeenCalled()
    }
  )

  it("rejects deleted or inaccessible documents for both send and history", async () => {
    mocks.db.knowledgeDocument.findFirst.mockResolvedValue(null)
    expect((await send("user-1", "submit-message", documentId)).status).toBe(
      404
    )
    expect((await chatRoute.request("/documents/" + documentId)).status).toBe(
      404
    )
    expect(mocks.db.chat.findFirst).not.toHaveBeenCalled()
    expect(mocks.languageModel).not.toHaveBeenCalled()
    expect(mocks.db.knowledgeDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: documentId,
          deletedAt: null,
          knowledgeBase: { userId: user.id, deletedAt: null },
        },
      })
    )
  })

  it("does not create a chat merely by opening preview history", async () => {
    const response = await chatRoute.request("/documents/" + documentId)
    expect(await response.json()).toEqual({
      success: true,
      chat: null,
      messages: [],
    })
    expect(mocks.db.chat.createMany).not.toHaveBeenCalled()
  })

  it("lists ordinary conversations separately from preview sessions", async () => {
    const response = await chatRoute.request("/")
    expect(response.status).toBe(200)
    expect(mocks.db.chat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: user.id, documentId: null },
      })
    )
  })

  it("finishes the SSE response when persisted RRF scores lose decimal precision", async () => {
    mocks.search.mockResolvedValueOnce({
      ...retrieval,
      items: [{ ...retrieval.items[0], score: 1 / 65 }],
    })
    mocks.db.message.findUnique.mockImplementation(async ({ where }) => {
      const row = stored.find((message) => message.id === where.id)
      if (row?.role !== "assistant") return row
      return {
        ...row,
        parts: JSON.parse(
          JSON.stringify(row.parts, (_key, value) =>
            typeof value === "number" ? Number(value.toPrecision(15)) : value
          )
        ),
      }
    })
    useModel(searchStep(), answerStep())
    await readResponse(await send())
    expect(mocks.db.chat.updateMany).toHaveBeenCalledWith({
      where: { id: chatId, userId: user.id },
      data: { modelId },
    })
  })

  it("executes retrieval in the authenticated user's full scope, continues answering, and saves tool parts", async () => {
    const model = useModel(searchStep(), answerStep())
    const sse = await readResponse(await send())
    expect(mocks.search).toHaveBeenCalledTimes(1)
    expect(mocks.search.mock.calls[0]).toEqual([
      user.id,
      { query: "如何上传", documentId: undefined, mode: "hybrid", limit: 6 },
      expect.any(AbortSignal),
    ])
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doStreamCalls[1].prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: expect.arrayContaining([
            expect.objectContaining({
              toolName: "searchKnowledge",
              output: { type: "json", value: retrieval },
            }),
          ]),
        }),
      ])
    )
    expect(sse).toContain('"type":"tool-output-available"')
    expect(sse).toContain("点击上传按钮")
    expect(stored.at(-1)).toMatchObject({
      role: "assistant",
      metadata: expect.objectContaining({ citationChunkIds: ["chunk-1"] }),
      promptTokens: 2,
      completionTokens: 2,
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "tool-searchKnowledge",
          state: "output-available",
          output: retrieval,
        }),
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("chunkId: chunk-1"),
        }),
      ]),
    })
  })


  it("lists owned documents without semantic search, preserves pending states, and reloads tool history", async () => {
    mocks.db.knowledgeDocument.findMany.mockResolvedValue([
      {
        id: documentId,
        title: "上传指南",
        knowledgeBaseId,
        knowledgeBase: { name: "项目资料" },
        status: "READY",
        chunkStatus: "READY",
        contentRevision: 2,
        chunkedContentRevision: 2,
      },
      {
        id: "20000000-0000-4000-8000-000000000004",
        title: "待解析文档",
        knowledgeBaseId,
        knowledgeBase: { name: "项目资料" },
        status: "PARSING",
        chunkStatus: "PENDING",
        contentRevision: 0,
        chunkedContentRevision: null,
      },
    ])
    const model = useModel(
      externalStep("listKnowledgeDocuments", {}),
      answerStep("项目资料有上传指南和待解析文档。")
    )
    await readResponse(
      await send("user-1", "submit-message", undefined, modelId, "我的知识库有什么？")
    )
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.db.knowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          knowledgeBase: { userId: user.id, deletedAt: null },
        },
      })
    )
    const output = {
      documents: [
        expect.objectContaining({ documentTitle: "上传指南", indexed: true }),
        expect.objectContaining({
          documentTitle: "待解析文档",
          status: "PARSING",
          indexed: false,
        }),
      ],
      hasMore: false,
    }
    expect(stored.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-listKnowledgeDocuments",
          state: "output-available",
          output,
        }),
      ])
    )
    expect(model.doStreamCalls[1].prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: expect.arrayContaining([
            expect.objectContaining({
              toolName: "listKnowledgeDocuments",
              output: { type: "json", value: output },
            }),
          ]),
        }),
      ])
    )
    const followup = useModel(answerStep("待解析文档仍在解析。"))
    await readResponse(await send("user-2"))
    expect(JSON.stringify(followup.doStreamCalls[0].prompt)).toContain(
      "listKnowledgeDocuments"
    )
    expect(mocks.db.knowledgeDocument.findMany).toHaveBeenCalledTimes(1)
  })

  it("rejects model attempts to override the document inventory owner", async () => {
    useModel(
      externalStep("listKnowledgeDocuments", { userId: "another-user" }),
      answerStep("无法列出资料。")
    )
    const sse = await readResponse(await send())
    expect(sse).toContain('"type":"tool-output-error"')
    expect(mocks.db.knowledgeDocument.findMany).not.toHaveBeenCalled()
  })

  it("reports inventory failures instead of pretending the knowledge base is empty", async () => {
    mocks.db.knowledgeDocument.findMany.mockRejectedValue(
      new Error("database unavailable")
    )
    useModel(
      externalStep("listKnowledgeDocuments", {}),
      answerStep("文档目录读取失败。")
    )
    const sse = await readResponse(await send())
    expect(sse).toContain('"type":"tool-output-error"')
    expect(stored.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-listKnowledgeDocuments",
          state: "output-error",
        }),
      ])
    )
  })

  it("allows a normal reply without calling retrieval", async () => {
    const model = useModel(answerStep("你好！"))
    await readResponse(await send())
    expect(mocks.search).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: "auto" })
    expect(model.doStreamCalls[0].providerOptions).toMatchObject({
      deepseek: { thinking: { type: "enabled" } },
    })
  })

  it("limits the loop to two retrieval rounds and forces a final answer on step three", async () => {
    const model = useModel(
      searchStep(),
      searchStep("上传大小限制", "call-2"),
      answerStep()
    )
    await readResponse(await send())
    expect(mocks.search).toHaveBeenCalledTimes(2)
    expect(model.doStreamCalls).toHaveLength(3)
    expect(model.doStreamCalls[2].toolChoice).toEqual({ type: "none" })
  })

  it("loads saved tool history on a follow-up without replaying the old search", async () => {
    useModel(searchStep(), answerStep())
    await readResponse(await send())
    const model = useModel(
      searchStep("上传文件大小限制", "call-2"),
      answerStep("上限以文档规定为准。")
    )
    await readResponse(await send("user-2"))
    expect(mocks.search).toHaveBeenCalledTimes(2)
    expect(model.doStreamCalls[0].prompt).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool" })])
    )
    expect(stored).toHaveLength(4)
  })

  it("does not send unfinished tool calls from a stopped response to the next model call", async () => {
    stored.push({
      id: "stopped",
      chatId,
      role: "assistant",
      createdAt: new Date(),
      modelId,
      finishReason: "other",
      metadata: { isAborted: true },
      promptTokens: null,
      completionTokens: null,
      parts: [
        { type: "text", text: "正在查找资料" },
        {
          type: "tool-searchKnowledge",
          toolCallId: "unfinished",
          state: "input-available",
          input: { query: "上传" },
        },
      ],
    })
    const model = useModel(answerStep())
    await readResponse(await send())
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "unfinished"
    )
    expect(JSON.stringify(stored[0].parts)).toContain("unfinished")
  })

  it("regenerates by removing the old answer and its tool result before a new search", async () => {
    useModel(searchStep(), answerStep())
    await readResponse(await send())
    const model = useModel(searchStep("新的上传要求", "new-call"), answerStep())
    await readResponse(await send("user-1", "regenerate-message"))
    expect(stored).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "call-1"
    )
    expect(mocks.search).toHaveBeenCalledTimes(2)
  })

  it("streams an actual tool error and lets the model explain retrieval failure", async () => {
    mocks.search.mockRejectedValueOnce(new Error("retrieval unavailable"))
    const model = useModel(
      searchStep(),
      answerStep("知识库检索失败，请稍后重试。")
    )
    const sse = await readResponse(await send())
    expect(model.doStreamCalls).toHaveLength(2)
    expect(sse).toContain('"type":"tool-output-error"')
    expect(stored.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-searchKnowledge",
          state: "output-error",
        }),
      ])
    )
    // 失败的工具消息也必须能被下一轮加载。
    useModel(answerStep("请稍后重试。"))
    await readResponse(await send("user-2"))
  })

  it("preserves empty hits and degradation warnings in model context", async () => {
    const empty = {
      items: [],
      warnings: [{ stage: "embedding", message: "仅使用关键词检索" }],
    }
    mocks.search.mockResolvedValueOnce(empty)
    const model = useModel(
      searchStep(),
      answerStep("本次仅使用关键词检索，未找到相关资料。")
    )
    await readResponse(await send())
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "仅使用关键词检索"
    )
    expect(stored.at(-1)?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ output: empty })])
    )
  })

  it("rejects an unauthenticated caller before invoking the model or retrieval", async () => {
    mocks.getSession.mockResolvedValue(null)
    expect((await send()).status).toBe(401)
    expect(mocks.languageModel).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it("rejects another user's chat before invoking the model or retrieval", async () => {
    mocks.db.chat.findUnique.mockResolvedValue({
      id: chatId,
      userId: "other-owner",
      modelId,
    })
    expect((await send()).status).toBe(404)
    expect(mocks.languageModel).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
  })
})
