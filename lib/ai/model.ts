export const CHAT_MODEL_IDS = ["deepseek-v4-pro", "qwen-plus"] as const

export type ChatModelId = (typeof CHAT_MODEL_IDS)[number]

export interface ChatModel {
  id: ChatModelId
  name: string
  description: string
}

export const chatModels: readonly ChatModel[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description:
      "DeepSeek是一个强大的多模态大语言模型，支持文本、图像、音频等多种输入类型，能够进行复杂的推理和生成任务。",
  },
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    description:
      "Alibaba是阿里巴巴推出的多模态大语言模型，支持文本、图像、音频等多种输入类型，能够进行复杂的推理和生成任务。",
  },
]

export const DEFAULT_MODEL_ID: ChatModelId = CHAT_MODEL_IDS[0]
export const DEVELOPMENT_CHAT_MODEL: ChatModelId = "deepseek-v4-pro"

export const MODEL_OPTIONS = chatModels.map((model) => ({
  value: model.id,
  label: model.name,
}))
