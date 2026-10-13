"use client"

import { useState } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import type { UIMessage } from "ai"
import { api } from "@/lib/hono/hono-rpc"
import { useAiChat } from "@/hooks/use-ai-chat"
import type { ChatDetailResponse } from "@/hooks/use-chat-list"
import { MessageList } from "@/components/chat/message-list"
import { ChatComposer } from "@/components/chat/chat-composer"
import { Button } from "@/components/ui/button"
import { chatModels, DEFAULT_MODEL_ID, type ChatModelId } from "@/lib/ai/model"

export function DocumentChat({
  documentId,
  ready,
  expanded,
  onToggleExpand,
}: {
  documentId: string
  ready: boolean
  expanded: boolean
  onToggleExpand: () => void
}) {
  const [newChatId] = useState(() => crypto.randomUUID())
  const history = useQuery({
    queryKey: ["document-chat", documentId],
    queryFn: async ({ signal }) => {
      const response = await api.chat.documents[":documentId"].$get(
        { param: { documentId } },
        { init: { signal } }
      )
      if (!response.ok) throw new Error("读取文档问答失败，请重新加载")
      // 复用聊天消息契约，避免 Hono 递归展开 UIMessage 的 JSON 类型。
      return (await response.json()) as {
        chat: ChatDetailResponse["chat"] | null
        messages: UIMessage[]
      }
    },
    retry: false,
  })
  if (history.isPending)
    return (
      <p role="status" className="p-4 text-sm">
        正在读取文档问答…
      </p>
    )
  if (history.isError)
    return (
      <div role="alert" className="space-y-2 p-4 text-sm">
        <p>{history.error.message}</p>
        <Button variant="outline" onClick={() => history.refetch()}>
          重新加载
        </Button>
      </div>
    )
  const chatId = history.data.chat?.id ?? newChatId
  const modelId =
    chatModels.find((model) => model.id === history.data.chat?.modelId)?.id ??
    DEFAULT_MODEL_ID
  return (
    <DocumentChatSession
      key={chatId}
      chatId={chatId}
      documentId={documentId}
      initialMessages={history.data.messages}
      initialModelId={modelId}
      ready={ready}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
    />
  )
}

function DocumentChatSession({
  chatId,
  documentId,
  initialMessages,
  initialModelId,
  ready,
  expanded,
  onToggleExpand,
}: {
  chatId: string
  documentId: string
  initialMessages: UIMessage[]
  initialModelId: ChatModelId
  ready: boolean
  expanded: boolean
  onToggleExpand: () => void
}) {
  const [input, setInput] = useState("")
  const [modelId, setModelId] = useState(initialModelId)
  const chat = useAiChat({
    chatId,
    documentId,
    initialMessages,
    selectedModelId: modelId,
  })
  return (
    <section aria-label="当前文档问答" className="flex h-full min-h-0 flex-col">
      <div className="border-b p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">文档问答</h3>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? "恢复分栏预览" : "展开文档问答"}
            title={expanded ? "恢复分栏预览" : "展开文档问答"}
            aria-pressed={expanded}
            onClick={onToggleExpand}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          仅检索当前文档，回答和引用自动保存。
        </p>
      </div>
      <MessageList
        chatId={chatId}
        messages={chat.messages}
        status={chat.status}
        error={chat.error}
        onRetry={() => {
          void chat.regenerate()
        }}
        onRegenerate={(id) => {
          void chat.regenerate(id)
        }}
      />
      <div className="border-t p-3">
        {ready || chat.isGenerating ? (
          <ChatComposer
            value={input}
            onValueChange={setInput}
            selectedModelId={modelId}
            onModelChange={setModelId}
            onStop={chat.stop}
            status={chat.status}
            allowAttachments={false}
            placeholder="针对当前文档提问"
            onSubmit={({ text }) => chat.sendText(text)}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            文档解析或索引尚未完成，完成后即可提问。索引失败时请重新解析或重建索引。
          </p>
        )}
      </div>
    </section>
  )
}
