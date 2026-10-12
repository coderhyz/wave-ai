import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import ModeToggle from "@/components/mode-toggle"
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth.api.getSession({
    headers: await headers(), // you need to pass the headers object.
  })

  if (session) {
    return redirect("/chat")
  }
  return (
    <>
      {" "}
      <div className="absolute top-4 right-4">
        <ModeToggle></ModeToggle>
      </div>
      <div className="flex h-screen items-center justify-center">
        {children}
      </div>
    </>
  )
}
