"use client";

import { z } from "zod";
import { useForm } from "react-hook-form";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client"; // 导入 authClient 实例
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthToken } from "@/hooks/use-auth-token";
import Link from "next/link";
// 注册表单的验证模式
const signUpSchema = z.object({
    name: z
        .string()
        .min(2, "名字长度必须在2-50个字符之间")
        .max(50, "名字长度必须在2-50个字符之间"),
    email: z.email("请输入有效的邮箱地址"),

    password: z
        .string()
        .min(6, "密码长度必须大于6个字符")
        .regex(/[A-Z]/, "密码必须包含大写字母"),
});
type SignUpFormData = z.infer<typeof signUpSchema>;

function SignupForm() {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(false);
    const bearerToken = useAuthToken((state) => state.bearerToken);
    const signUpForm = useForm<SignUpFormData>({
        resolver: zodResolver(signUpSchema),
        // 注册的默认值
        defaultValues: {
            name: "",
            email: "",
            password: "",
        },
    });
    async function onSubmit(data: SignUpFormData) {
        try {
            await authClient.signUp.email({
                name: data.name,
                email: data.email,
                password: data.password,
                callbackURL: `/home`, // 注册成功后重定向到 /home 页面
            },
                {
                    onRequest: () => {
                        setIsLoading(true);
                    },
                    onSuccess: (ctx) => {
                        const authToken = ctx.response.headers.get("set-auth-token");
                        useAuthToken.getState().setBearerToken(authToken);
                        // 注册成功后，重定向到登录页
                        router.push("/home");
                        setIsLoading(false);
                    },
                    onError: (error) => {
                        console.error("注册失败:", error);
                        setIsLoading(false);
                    }
                }
            )
        }
        catch (error) {
            console.error("注册失败:", error);
            toast.error("error", {
                description: "注册失败，请稍后再试",
            });
        }
        finally {
            setIsLoading(false);
        }
    }
    return (
        <div className="flex flex-col gap-6 w-full max-w-md ">
            <Card className="bg-transparent! border-0">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl font-bold">注册</CardTitle>
                    <CardDescription>请输入您的信息进行注册</CardDescription>
                </CardHeader>
                <CardContent>
                    {/* 注册表单内容 */}
                    <Form {...signUpForm} >
                        <form onSubmit={signUpForm.handleSubmit(onSubmit)} className="space-y-6">
                            {/* 名字输入框 */}
                            <FormField control={signUpForm.control} name="name" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>名字</FormLabel>
                                    <FormControl>
                                        <Input placeholder="请输入名字" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            {/* 邮箱输入框 */}
                            <FormField control={signUpForm.control} name="email" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>邮箱</FormLabel>
                                    <FormControl>
                                        <Input placeholder="请输入邮箱" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            {/* 密码输入框 */}
                            <FormField control={signUpForm.control} name="password" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>密码</FormLabel>
                                    <FormControl>
                                        <Input placeholder="请输入密码" type="password" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            {/* 提交按钮 */}
                            <Button className="w-full" type="submit" disabled={isLoading}>
                                {isLoading ? "注册中..." : "注册"}
                            </Button>
                            <div className="text-center text-sm">
                                已经有账号?{" "}
                                <Link
                                    href="/auth/sign-in"
                                    className="underline underline-offset-4"
                                >
                                    请登录
                                </Link>
                            </div>
                        </form>
                    </Form>
                </CardContent>
            </Card>
        </div>
    );
}

export default SignupForm;
