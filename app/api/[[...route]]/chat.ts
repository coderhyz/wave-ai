import { Hono } from "hono";
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import z from "zod";
import { ChatModel } from "@/lib/ai/model";
import { type UIMessage } from "@ai-sdk/react"
import { getAuthUser } from "@/lib/hono/hono-middware";
import { generateTitleForUserMessage } from "@/app/action/action";
import prisma from "@/lib/prisma";
import { type UIMessagePart } from "ai";
// 参数校验
const chatSchema = z.object({
    id: z.string().min(1),
    message: z.custom<UIMessage>(),
    selectedModelId: z.string() as z.ZodType<ChatModel["id"]>,
    selectedToolName: z.string().nullable(),
});
// 聊天接口
export const chatRoute = new Hono()
    .post("/", zValidator('json', chatSchema), getAuthUser, async (c) => {
        // 创建聊天
        const user = c.get("user");
        const { id, message, selectedModelId, selectedToolName } = c.req.valid('json');
        let chat = await prisma.chat.findUnique({
            where: {
                id
            }
        });
        if (!chat) {
            // 生成的标题
            const generateTitle = await generateTitleForUserMessage({ message });
            // 创建聊天
            chat = await prisma.chat.create({
                data: {
                    id,
                    userId: user.id,
                    title: generateTitle
                }
            });
        }
        // 服务器的消息
        const messagesFromDB = await prisma.message.findMany({
            where: { chatId: id },
            orderBy: { createdAt: "desc" },
        });
        const mapUIMessages: UIMessage[] = messagesFromDB.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant" | "system",
            parts: m.parts as UIMessagePart<any, any>[],
            metadata: {
                createdAt: m.createdAt,
            },
        }));
        const newUIMessages = [...mapUIMessages, message];

    })