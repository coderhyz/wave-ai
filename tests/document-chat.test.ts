import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, useQuery } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DocumentChat } from "@/components/knowledge/document/document-chat"

const mocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  composer: vi.fn(),
  messageList: vi.fn(),
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: vi.fn(),
}))
vi.mock("@/hooks/use-ai-chat", () => ({ useAiChat: mocks.useChat }))
vi.mock("@/components/chat/message-list", () => ({
  MessageList: (props: unknown) => {
    mocks.messageList(props)
    return null
  },
}))
vi.mock("@/components/chat/chat-composer", () => ({
  ChatComposer: (props: unknown) => {
    mocks.composer(props)
    return null
  },
}))
const documentId = "20000000-0000-4000-8000-000000000002"
const fetchMock = vi.fn<typeof fetch>()
const history = {
  chat: { id: "saved-chat", modelId: "qwen-plus" },
  messages: [{ id: "saved-answer", role: "assistant", parts: [] }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", fetchMock)
  vi.mocked(useQuery).mockReturnValue({
    isPending: false,
    isError: false,
    data: history,
  } as ReturnType<typeof useQuery>)
  mocks.useChat.mockReturnValue({
    messages: history.messages,
    status: "ready",
    isGenerating: false,
    regenerate: vi.fn(),
    sendText: vi.fn(),
    stop: vi.fn(),
  })
})
afterEach(() => vi.unstubAllGlobals())
const render = (ready = true) =>
  renderToStaticMarkup(
    createElement(DocumentChat, {
      documentId,
      ready,
      expanded: false,
      onToggleExpand: vi.fn(),
    })
  )

describe("document preview chat", () => {
  it("initializes the persisted session with document scope, history and saved model", () => {
    expect(render()).toContain("仅检索当前文档")
    expect(mocks.useChat).toHaveBeenCalledWith({
      chatId: "saved-chat",
      documentId,
      initialMessages: history.messages,
      selectedModelId: "qwen-plus",
    })
    expect(mocks.messageList).toHaveBeenCalledWith(
      expect.objectContaining({ messages: history.messages })
    )
    expect(mocks.composer).toHaveBeenCalledWith(
      expect.objectContaining({
        allowAttachments: false,
        placeholder: "针对当前文档提问",
      })
    )
  })
  it("loads history from the authenticated document endpoint with cancellation", async () => {
    render()
    const options = vi.mocked(useQuery).mock.calls[0][0]
    if (typeof options.queryFn !== "function")
      throw new Error("Expected query function")
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(Response.json(history))
    const result = await options.queryFn({
      queryKey: ["document-chat", documentId],
      signal: controller.signal,
      client: new QueryClient(),
      meta: undefined,
    })
    expect(result).toEqual(history)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/chat/documents/" + documentId
    )
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "include",
      signal: controller.signal,
    })
  })
  it("keeps history visible while blocking input until indexing is ready", () => {
    expect(render(false)).toContain("文档解析或索引尚未完成")
    expect(mocks.messageList).toHaveBeenCalledOnce()
    expect(mocks.composer).not.toHaveBeenCalled()
  })
  it("keeps the stop action available if indexing changes during generation", () => {
    mocks.useChat.mockReturnValue({
      messages: [],
      status: "streaming",
      isGenerating: true,
      stop: vi.fn(),
    })
    render(false)
    expect(mocks.composer).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "streaming",
        onStop: expect.any(Function),
      })
    )
  })
  it("shows a loading state before creating the chat hook", () => {
    vi.mocked(useQuery).mockReturnValue({ isPending: true } as ReturnType<
      typeof useQuery
    >)
    expect(render()).toContain("正在读取文档问答")
    expect(mocks.useChat).not.toHaveBeenCalled()
  })
})
