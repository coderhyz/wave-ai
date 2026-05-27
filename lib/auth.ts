import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
// prisma 客户端实例
import { PrismaClient } from "@/app/generated/prisma";

import { bearer } from "better-auth/plugins";
// 创建 Prisma 客户端实例
const prisma = new PrismaClient();
// 导出的 auth 实例可以在整个应用中使用
export const auth = betterAuth({
    //...other options
    // 允许邮箱密码登录
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 6, // 最小密码长度
    },
    database: prismaAdapter(prisma, {
        provider: "postgresql", // or "mysql", "postgresql", ...etc
    }),
    plugins: [
        bearer(),
    ],
});