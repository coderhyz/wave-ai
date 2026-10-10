import { createAlibaba } from "@ai-sdk/alibaba"
import { deepseek } from "@ai-sdk/deepseek"
import type { ProviderOptions } from "@ai-sdk/provider-utils"
import { customProvider } from "ai"
import { chatModels, DEVELOPMENT_CHAT_MODEL, type ChatModelId } from "./model"
import { getModelGenerationSettings } from "./generation-settings"

const qwen = createAlibaba({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
})
// 模型提供商
export const myProvider = customProvider({
  languageModels: {
    [DEVELOPMENT_CHAT_MODEL]: deepseek.languageModel(DEVELOPMENT_CHAT_MODEL),
    "qwen-plus": qwen.languageModel("qwen-plus"),
    "qwen3.7-flash": qwen.languageModel("qwen3.7-flash"),
    "title-model": deepseek.languageModel("deepseek-v4-pro"),
  },
})

/** 必须按实际执行模型取预算，包括图片输入时自动切换到的视觉模型。 */
export const getChatGenerationSettings = (modelId: ChatModelId) => {
  const model = chatModels.find((item) => item.id === modelId)
  if (!model) throw new Error(`未知的聊天模型：${modelId}`)
  return getModelGenerationSettings(model)
}

/** 保留现有导出；新调用应使用完整配置，以同时限制正文和思考。 */
export const getReasoningProviderOptions = (
  modelId: ChatModelId
): ProviderOptions => getChatGenerationSettings(modelId).providerOptions
