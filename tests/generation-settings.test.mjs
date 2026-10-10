import assert from "node:assert/strict"
import { test } from "node:test"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createAlibaba } from "@ai-sdk/alibaba"
import { chatModels, resolveChatModelId } from "../lib/ai/model.ts"
import {
  getModelGenerationSettings,
  TITLE_GENERATION_SETTINGS,
} from "../lib/ai/generation-settings.ts"

const getModel = (id) => chatModels.find((model) => model.id === id)

test("all registered chat models have finite output limits", () => {
  for (const model of chatModels) {
    const settings = getModelGenerationSettings(model)
    assert.equal(settings.maxOutputTokens, 4096)
    assert.ok(Number.isSafeInteger(settings.maxOutputTokens))
  }
})

test("DeepSeek uses a combined output limit and low reasoning effort", () => {
  assert.deepEqual(getModelGenerationSettings(getModel("deepseek-v4-pro")), {
    maxOutputTokens: 4096,
    providerOptions: {
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "low" },
    },
  })
})

test("Qwen Flash has an independent reasoning budget", () => {
  assert.deepEqual(getModelGenerationSettings(getModel("qwen3.7-flash")), {
    maxOutputTokens: 4096,
    providerOptions: {
      alibaba: { enableThinking: true, thinkingBudget: 1024 },
    },
  })
})

test("Qwen Plus stays non-thinking without sending an invalid zero budget", () => {
  assert.deepEqual(getModelGenerationSettings(getModel("qwen-plus")), {
    maxOutputTokens: 4096,
    providerOptions: { alibaba: { enableThinking: false } },
  })
})

test("vision fallback uses the actual model's reasoning limit", () => {
  const modelId = resolveChatModelId("deepseek-v4-pro", true)
  assert.equal(modelId, "qwen3.7-flash")
  assert.equal(
    getModelGenerationSettings(getModel(modelId)).providerOptions.alibaba
      .thinkingBudget,
    1024
  )
})

test("configuration can disable thinking or change supported budgets", () => {
  const flash = getModel("qwen3.7-flash")
  assert.equal(
    getModelGenerationSettings({ ...flash, reasoningTokenBudget: 2048 })
      .providerOptions.alibaba.thinkingBudget,
    2048
  )
  assert.deepEqual(
    getModelGenerationSettings({ ...flash, reasoningTokenBudget: 0 })
      .providerOptions.alibaba,
    { enableThinking: false }
  )
  assert.deepEqual(
    getModelGenerationSettings({
      ...getModel("deepseek-v4-pro"),
      reasoningTokenBudget: 0,
    }).providerOptions.deepseek,
    { thinking: { type: "disabled" } }
  )
})

test("rejects invalid or unsupported budgets rather than making unbounded calls", () => {
  const flash = getModel("qwen3.7-flash")
  for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => getModelGenerationSettings({ ...flash, maxOutputTokens }),
      /正整数/
    )
  }
  for (const reasoningTokenBudget of [-1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => getModelGenerationSettings({ ...flash, reasoningTokenBudget }),
      /非负整数/
    )
  }
  assert.throws(
    () =>
      getModelGenerationSettings({
        ...getModel("deepseek-v4-pro"),
        reasoningTokenBudget: 1024,
      }),
    /不支持独立/
  )
})

test("title generation is capped and explicitly non-thinking", () => {
  assert.deepEqual(TITLE_GENERATION_SETTINGS, {
    maxOutputTokens: 256,
    providerOptions: { deepseek: { thinking: { type: "disabled" } } },
  })
})

// 用真实 Provider SDK 和本地 mock 响应检查 HTTP 参数，不读取密钥或调用付费模型。
for (const id of [
  "deepseek-v4-pro",
  "qwen-plus",
  "qwen3.7-flash",
  "title-model",
]) {
  test(`${id}: SDK forwards the configured limits to the request body`, async () => {
    let requestBody
    const fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body)
      return Response.json({
        id: "test-completion",
        created: 1,
        model: id,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    const isDeepSeek = id === "deepseek-v4-pro" || id === "title-model"
    const provider = isDeepSeek
      ? createDeepSeek({ apiKey: "test-only", fetch })
      : createAlibaba({ apiKey: "test-only", fetch })
    const settings =
      id === "title-model"
        ? TITLE_GENERATION_SETTINGS
        : getModelGenerationSettings(getModel(id))
    await provider
      .languageModel(isDeepSeek ? "deepseek-v4-pro" : id)
      .doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        ...settings,
      })
    assert.equal(requestBody.max_tokens, settings.maxOutputTokens)
    if (isDeepSeek) {
      assert.deepEqual(requestBody.thinking, {
        type: id === "title-model" ? "disabled" : "enabled",
      })
      assert.equal(
        requestBody.reasoning_effort,
        id === "title-model" ? undefined : "low"
      )
      assert.equal(requestBody.thinking_budget, undefined)
    } else {
      assert.equal(requestBody.enable_thinking, id === "qwen3.7-flash")
      assert.equal(
        requestBody.thinking_budget,
        id === "qwen3.7-flash" ? 1024 : undefined
      )
    }
  })
}
