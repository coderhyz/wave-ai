import type { ProviderOptions } from "@ai-sdk/provider-utils"
import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek"
import type { AlibabaLanguageModelOptions } from "@ai-sdk/alibaba"
import type { ChatModel } from "./model"

/** 只生成供应商确实支持的参数，预算在服务端配置，不允许客户端放大。 */
export function getModelGenerationSettings(model: ChatModel): {
  maxOutputTokens: number
  providerOptions: ProviderOptions
} {
  const { maxOutputTokens, reasoningTokenBudget } = model
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("模型输出 Token 上限必须为正整数")
  }
  if (
    reasoningTokenBudget !== null &&
    (!Number.isSafeInteger(reasoningTokenBudget) || reasoningTokenBudget < 0)
  ) {
    throw new Error("模型思考 Token 预算必须为非负整数")
  }

  if (model.brand === "deepseek") {
    if (reasoningTokenBudget !== null && reasoningTokenBudget > 0) {
      throw new Error(
        "DeepSeek 不支持独立的思考 Token 预算，请使用合计输出上限"
      )
    }
    const enableThinking = model.supportsReasoning && reasoningTokenBudget !== 0
    return {
      maxOutputTokens,
      providerOptions: {
        deepseek: {
          thinking: { type: enableThinking ? "enabled" : "disabled" },
          ...(enableThinking ? { reasoningEffort: "low" as const } : {}),
        } satisfies DeepSeekLanguageModelOptions,
      },
    }
  }

  const enableThinking =
    model.supportsReasoning &&
    reasoningTokenBudget !== null &&
    reasoningTokenBudget > 0
  return {
    maxOutputTokens,
    providerOptions: {
      alibaba: {
        enableThinking,
        // 不向供应商发送非法的 thinking_budget: 0，关闭思考用独立开关。
        ...(enableThinking ? { thinkingBudget: reasoningTokenBudget } : {}),
      } satisfies AlibabaLanguageModelOptions,
    },
  }
}

/** 标题只是简短摘要，不需要额外思考；防止辅助调用使用默认的大额预算。 */
export const TITLE_GENERATION_SETTINGS = {
  maxOutputTokens: 256,
  providerOptions: {
    deepseek: {
      thinking: { type: "disabled" },
    } satisfies DeepSeekLanguageModelOptions,
  },
}
