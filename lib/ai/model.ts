export const CHAT_MODEL_IDS = [
  "deepseek-v4-pro",
  "qwen-plus",
  "qwen3.7-flash",
] as const

export type ChatModelId = (typeof CHAT_MODEL_IDS)[number]

export interface ChatModel {
  id: ChatModelId
  name: string
  brand: "deepseek" | "qwen"
  description: string
  supportsImageInput: boolean
  supportsReasoning: boolean
  /** 传给 AI SDK；DeepSeek 限思考与正文之和，当前千问接口仅限正文。 */
  maxOutputTokens: number
  /** 独立思考预算：0 关闭思考；null 表示供应商不支持独立 Token 限制。 */
  reasoningTokenBudget: number | null
}

export const chatModels: readonly ChatModel[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    brand: "deepseek",
    description: "DeepSeek 文本推理模型，不直接支持图片输入。",
    supportsImageInput: false,
    supportsReasoning: true,
    maxOutputTokens: 4096,
    reasoningTokenBudget: null,
  },
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    brand: "qwen",
    description: "通义千问文本模型，适合通用问答和内容生成。",
    supportsImageInput: false,
    supportsReasoning: true,
    maxOutputTokens: 4096,
    // Qwen Plus 支持思考，但保持项目原有的关闭状态，不额外增加消耗。
    reasoningTokenBudget: 0,
  },
  {
    id: "qwen3.7-flash",
    name: "Qwen 3.7 Flash",
    brand: "qwen",
    description:
      "通义千问 3.7 系列的高速模型，兼顾响应速度、成本与多模态理解能力。",
    supportsImageInput: true,
    supportsReasoning: true,
    maxOutputTokens: 4096,
    reasoningTokenBudget: 1024,
  },
]

/** 当前项目用于处理图片输入的默认视觉模型。 */
export const DEFAULT_VISION_MODEL_ID: ChatModelId = "qwen3.7-flash"

/** 图片消息误选纯文本模型时，自动回退到视觉模型。 */
export const resolveChatModelId = (
  selectedModelId: ChatModelId,
  hasImageInput: boolean
): ChatModelId => {
  if (!hasImageInput) {
    return selectedModelId
  }

  const selectedModel = chatModels.find((model) => model.id === selectedModelId)

  return selectedModel?.supportsImageInput
    ? selectedModelId
    : DEFAULT_VISION_MODEL_ID
}

export const DEFAULT_MODEL_ID: ChatModelId = CHAT_MODEL_IDS[0]
export const DEVELOPMENT_CHAT_MODEL: ChatModelId = "deepseek-v4-pro"

export const MODEL_OPTIONS = chatModels.map((model) => ({
  value: model.id,
  label: model.name,
}))
