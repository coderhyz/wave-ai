import type { Message, Prisma } from "@/app/generated/prisma"
import type { UIMessage } from "ai"

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

const isJsonObject = (
  value: Prisma.JsonValue | null
): value is Prisma.JsonObject =>
  value !== null && !Array.isArray(value) && typeof value === "object"

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

export const toInputJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

export const getMessageText = (message: Pick<UIMessage, "parts">) =>
  message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()

export const createProvisionalTitle = (message: Pick<UIMessage, "parts">) => {
  const text = getMessageText(message).replace(/\s+/g, " ")

  if (!text) {
    return "新对话"
  }

  return text.length > 50 ? `${text.slice(0, 50)}…` : text
}
