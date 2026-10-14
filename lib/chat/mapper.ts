import type { Message, Prisma } from "@/app/generated/prisma"
import type { UIMessage } from "ai"

/** 网页搜索默认开启；历史消息记录关闭时，重新打开会话恢复该设置。 */
export function getMessageWebSearchEnabled(message?: Pick<UIMessage, "metadata">): boolean {
  const metadata = message?.metadata
  return !(metadata && typeof metadata === "object" && "webSearchEnabled" in metadata && metadata.webSearchEnabled === false)
}

/**
 * 数据库消息转换为前端消息时会用到的字段集合。
 * 只选取转换所需字段，避免该模块依赖完整的 Message 类型。
 */
type StoredMessage = Pick<
  Message,
  | "id"
  | "role"
  | "parts"
  | "metadata"
  | "modelId"
  | "finishReason"
  | "promptTokens"
  | "completionTokens"
  | "createdAt"
>

/** 判断 Prisma JSON 数据是否为可以安全展开的普通对象。 */
const isJsonObject = (
  value: Prisma.JsonValue | null
): value is Prisma.JsonObject =>
  value !== null && !Array.isArray(value) && typeof value === "object"

/**
 * 将数据库消息转换为 AI SDK 前端组件使用的 UIMessage。
 * 模型信息、结束原因和 Token 用量会被合并进 metadata。
 */
export const toUIMessage = (message: StoredMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: message.parts as UIMessage["parts"],
  metadata: {
    ...(isJsonObject(message.metadata) ? message.metadata : {}),
    createdAt: message.createdAt.toISOString(),
    modelId: message.modelId,
    finishReason: message.finishReason,
    promptTokens: message.promptTokens,
    completionTokens: message.completionTokens,
  },
})

/** 将可序列化数据转换为 Prisma JSON 字段接受的输入类型。 */
export const toInputJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** 提取消息中的所有文本分片，并使用换行符连接。 */
export const getMessageText = (message: Pick<UIMessage, "parts">) =>
  message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()

/** 使用用户消息生成新会话的临时标题。 */
export const createProvisionalTitle = (message: Pick<UIMessage, "parts">) => {
  const text = getMessageText(message).replace(/\s+/g, " ")

  if (!text) {
    const firstFilename = message.parts.find(
      (part): part is Extract<UIMessage["parts"][number], { type: "file" }> =>
        part.type === "file"
    )?.filename

    return firstFilename ? `附件：${firstFilename}` : "新对话"
  }

  return text.length > 50 ? `${text.slice(0, 50)}…` : text
}
