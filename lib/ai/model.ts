export interface ChatModel {
    id: string;
    name: string;
    description: string;
}
// 可用的模型
export const chatModels: ChatModel[] = [
    {
        id: "deepseek-v4-pro", // Updated to actual available model
        name: "DeepSeek V4 Pro",
        description:
            "DeepSeek's most intelligent model with tool use and real-time search",
    },
    {
        id: "qwen-plus", // Updated to actual available model
        name: "Qwen Plus",
        description: "Alibaba's most intelligent model with tool use and real-time search",
    },

];
// 默认使用第一个模型
export const DEFAULT_MODEL_ID = chatModels[0].id;
// 开发环境使用的模型，方便调试和测试
export const DEVELOPMENT_CHAT_MODEL = "deepseek-v4-pro";
// 模型选项
export const MODEL_OPTIONS = chatModels.map((model) => ({
    value: model.id,
    label: model.name,
}));