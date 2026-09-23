import { randomUUID } from "node:crypto"
import Header from "@/app/(routes)/(dashboard)/_common/header"
import { ChatShell } from "@/components/chat/chat-shell"

interface ChatPageProps {
  searchParams: Promise<{ chatId?: string | string[] }>
}

async function Chat({ searchParams }: ChatPageProps) {
  const params = await searchParams
  const selectedChatId =
    typeof params.chatId === "string" ? params.chatId : undefined
  const chatId = selectedChatId ?? randomUUID()

  return (
    <div className="h-dvh w-full overflow-hidden">
      <Header title="AI 对话" />
      <ChatShell chatId={chatId} loadHistory={Boolean(selectedChatId)} />
    </div>
  )
}

export default Chat
