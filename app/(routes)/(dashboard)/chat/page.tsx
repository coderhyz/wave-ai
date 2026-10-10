import { randomUUID } from "node:crypto"
import Header from "@/app/(routes)/(dashboard)/_common/header"
import { ChatShell } from "@/components/chat/chat-shell"

interface ChatPageProps {
  searchParams: Promise<{ chatId?: string | string[] }>
}

async function Chat({ searchParams }: ChatPageProps) {
  const params = await searchParams
  // 如果 URL 中有 chatId，则使用它；否则生成一个新的 UUID 作为 chatId。
  const selectedChatId =
    typeof params.chatId === "string" ? params.chatId : undefined
  const chatId = selectedChatId ?? randomUUID()

  return (
    <div className="h-dvh w-full overflow-hidden">
      <Header title="对话" />
      <ChatShell chatId={chatId} loadHistory={Boolean(selectedChatId)} />
    </div>
  )
}

export default Chat
