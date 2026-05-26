import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
async function WebLayout({ children }: { children: React.ReactNode }) {
    // 服务端的用法
    const session = await auth.api.getSession({
        headers: await headers()
    });

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