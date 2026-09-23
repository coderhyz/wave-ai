import { createAlibaba } from "@ai-sdk/alibaba"
import { deepseek } from "@ai-sdk/deepseek"
import { customProvider } from "ai"
import { DEVELOPMENT_CHAT_MODEL } from "./model"

const qwen = createAlibaba({
  apiKey: process.env.QWEN_API_KEY,
})

export const myProvider = customProvider({
  languageModels: {
    [DEVELOPMENT_CHAT_MODEL]: deepseek.languageModel(DEVELOPMENT_CHAT_MODEL),
    "qwen-plus": qwen.languageModel("qwen-plus"),
    "title-model": deepseek.languageModel("deepseek-chat"),
  },
})
