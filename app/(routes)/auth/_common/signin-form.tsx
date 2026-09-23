"use client"

import { z } from "zod"
import { useForm } from "react-hook-form"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Button } from "@/components/ui/button"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { authClient } from "@/lib/auth-client" // 导入 authClient 实例
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import Link from "next/link"
import { useAuthToken } from "@/hooks/use-auth-token"
// 登录表单的验证模式
const signInSchema = z.object({
  email: z.email("请输入有效的邮箱地址"),
  password: z
    .string()
    .min(6, "密码长度必须大于6个字符")
    .regex(/[A-Z]/, "密码必须包含大写字母"),
})
type SignInFormData = z.infer<typeof signInSchema>

function SignInForm() {
  // 路由实例
  const router = useRouter()
  // 是否正在加载状态
  const [isLoading, setIsLoading] = useState(false)
  const signInForm = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    // 登录的默认值
    defaultValues: {
      email: "",
      password: "",
    },
  })
  // 登录表单提交处理函数
  async function onSubmit(data: SignInFormData) {
    try {
      await authClient.signIn.email(
        {
          email: data.email,
          password: data.password,
          callbackURL: `/home`, // 登录成功后重定向到 /home 页面
        },
        {
          onRequest: () => {
            setIsLoading(true)
          },
          onSuccess: (ctx) => {
            const authToken = ctx.response.headers.get("set-auth-token")
            useAuthToken.getState().setBearerToken(authToken)
            // 登录成功后，重定向到 /home 页面
            router.push("/home")
            setIsLoading(false)
          },
          onError: (error) => {
            console.error("登录失败:", error)
            setIsLoading(false)
          },
        }
      )
    } catch (error) {
      console.error("登录失败:", error)
      toast.error("error", {
        description: "登录失败，请稍后再试",
      })
    } finally {
      setIsLoading(false)
    }
  }
  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <Card className="border-0 bg-transparent!">
        {/* 卡片头部 */}
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">登录</CardTitle>
          <CardDescription>请输入您的信息进行登录</CardDescription>
        </CardHeader>
        {/* 卡片内容 */}
        <CardContent>
          {/* 登录表单内容 */}
          <Form {...signInForm}>
            <form
              onSubmit={signInForm.handleSubmit(onSubmit)}
              className="space-y-6"
            >
              {/* 邮箱输入框 */}
              <FormField
                control={signInForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>邮箱</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入邮箱" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* 密码输入框 */}
              <FormField
                control={signInForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>密码</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="请输入密码"
                        type="password"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* 提交按钮 */}
              <Button className="w-full" type="submit" disabled={isLoading}>
                {isLoading ? "登录中..." : "登录"}
              </Button>
              <div className="text-center text-sm">
                还未注册?{" "}
                <Link
                  href="/auth/sign-up"
                  className="underline underline-offset-4"
                >
                  请注册
                </Link>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

export default SignInForm
