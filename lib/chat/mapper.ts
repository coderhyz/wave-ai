import type { Message, Prisma } from "@/app/generated/prisma"
import type { UIMessage } from "ai"

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

/**
 * 判断 Prisma JSON 数据是否为可以安全展开的普通对象。
 */
const isJsonObject = (
  value: Prisma.JsonValue | null
): value is Prisma.JsonObject =>
  value !== null && !Array.isArray(value) && typeof value === "object"

/**
 * 将数据库消息转换为 AI SDK 前端组件使用的 UIMessage。
 * 模型信息、结束原因和 Token 用量会被合并进 metadata。
 *
 * @param message 从数据库中读取的消息
 * @returns 前端可以直接渲染的 UIMessage
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

/**
 * 将可序列化数据转换为 Prisma JSON 字段接受的输入类型。
 * JSON 序列化也会自动移除 undefined 等非 JSON 数据。
 *
 * @param value 需要写入 Prisma JSON 字段的数据
 * @returns Prisma 可以保存的 JSON 数据
 */
export const toInputJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/**
 * 提取消息中的所有文本分片，并使用换行符连接。
 * 图片、附件和工具调用等非文本分片会被忽略。
 *
 * @param message 需要提取文本内容的消息
 * @returns 清理首尾空白后的消息文本
 */
export const getMessageText = (message: Pick<UIMessage, "parts">) =>
  message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()

/**
 * 使用用户消息生成新会话的临时标题。
 * 标题会压缩连续空白并截取前 50 个字符，空消息返回默认标题。
 *
 * @param message 用于生成标题的用户消息
 * @returns 新会话的临时标题
 */
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
