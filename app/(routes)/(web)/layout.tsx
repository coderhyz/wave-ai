import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
async function WebLayout({ children }: { children: React.ReactNode }) {
    // 获取当前用户会话
    const session = await auth.api.getSession({
        headers: await headers()
    });
    // 如果用户已登录，重定向到主页
    if (session) {
        return redirect("/home");
    }
    return (
        <div className="min-h-screen flex flex-col">
            <header className="bg-gray-800 text-white p-4 flex items-center justify-between">
                <h1 className="text-xl font-bold">Wave AI</h1>
                <div>
                    <Link href="/auth/sign-in" className="mr-4 hover:underline">
                        Login
                    </Link>
                    <Link href="/auth/sign-up" className="hover:underline">
                        Sign Up
                    </Link>
                </div>
            </header>
            <main className="flex-1 p-4">
                {/*  */}
                {children}
            </main>
            <footer className="bg-gray-800 text-white p-4 text-center">
                &copy; 2024 Wave AI. All rights reserved.
            </footer>
        </div>
    );
}

export default WebLayout;