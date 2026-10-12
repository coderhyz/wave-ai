import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"

export default async function WebLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // 查看是否登录
  const session = await auth.api.getSession({
    headers: await headers(), // you need to pass the headers object.
  })

  if (session) {
    return redirect("/chat")
  }

  return <div>{children}</div>
}
