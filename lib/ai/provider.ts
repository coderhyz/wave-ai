import { createAlibaba } from "@ai-sdk/alibaba"
import { deepseek } from "@ai-sdk/deepseek"
import { withContextChef } from "@context-chef/ai-sdk-middleware"
import {
  customProvider,
  defaultSettingsMiddleware,
  wrapLanguageModel,
} from "ai"
import { chatModels, DEVELOPMENT_CHAT_MODEL, type ChatModelId } from "./model"
import { getModelGenerationSettings } from "./generation-settings"
// 千问模型创建
const qwen = createAlibaba({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
})
const deepseekModel = deepseek.languageModel("deepseek-v4-pro")
const compressionModel = wrapLanguageModel({
  model: deepseekModel,
  middleware: defaultSettingsMiddleware({
    settings: {
      providerOptions: {
        deepseek: { thinking: { type: "disabled" } },
      },
    },
  }),
})
// 模型提供商
const provider = customProvider({
  languageModels: {
    [DEVELOPMENT_CHAT_MODEL]: deepseekModel,
    "qwen3.8-max": qwen.languageModel("qwen3.8-max"),
    "qwen3.8-flash": qwen.languageModel("qwen3.8-flash"),
    "title-model": deepseekModel,
  },
})

export const myProvider = {
  ...provider,
  languageModel(modelId: ChatModelId | "title-model") {
    const model = provider.languageModel(modelId)
    if (modelId === "title-model") return model
    // 每次获取模型独立创建压缩状态，避免并发会话相互影响。
    return withContextChef(model, {
      contextWindow: 64_000, // 应用的上下文预算，默认达到 70% 时压缩。
      // 压缩模型的配置
      compress: { model: compressionModel },
    })
  },
}

/** 必须按实际执行模型取预算，包括图片输入时自动切换到的视觉模型。 */
export const getChatGenerationSettings = (
  modelId: ChatModelId,
  { reasoning = true }: { reasoning?: boolean } = {}
) => {
  const model = chatModels.find((item) => item.id === modelId)
  if (!model) throw new Error(`未知的聊天模型：${modelId}`)
  return getModelGenerationSettings(
    reasoning ? model : { ...model, reasoningTokenBudget: 0 }
  )
}
