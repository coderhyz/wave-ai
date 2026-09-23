/* eslint-disable @typescript-eslint/no-explicit-any */
import { customProvider } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { deepseek } from "@ai-sdk/deepseek";
import { chatModels, DEVELOPMENT_CHAT_MODEL } from "./model";

const NODE_ENV = process.env.NODE_ENV!;

export const isProduction = NODE_ENV === "production";
// 创建语言模型实例
const createLanguageModels = (isProduction: boolean) => {
    const models: Record<string, any> = {};
    chatModels.forEach(
        (model) => (models[model.id] = gateway.languageModel(model.id))
    );

    models[DEVELOPMENT_CHAT_MODEL] = deepseek.languageModel(DEVELOPMENT_CHAT_MODEL);

    models["title-model"] = isProduction
        ? gateway.languageModel("deepseek/deepseek-r1")
        : deepseek.languageModel("deepseek-chat");

    return models;
};

export const myProvider = customProvider({
    languageModels: createLanguageModels(isProduction),
});