import { Suspense } from 'react';
import { RiLoader5Fill } from "@remixicon/react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import AppSidebar from "@/components/dashboard/app-sidebar";
import { auth } from "@/lib/auth"; // path to your Better Auth server instance
import { headers } from "next/headers";
import { redirect } from "next/navigation";
async function DashBoardLayout({ children }: { children: React.ReactNode }) {
    const session = await auth.api.getSession({
        headers: await headers() // you need to pass the headers object.
    })
    if (!session) {
        // 如果没有 session，重定向到登录页
        redirect('/auth/login');
    }
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center h-screen">
                <RiLoader5Fill className='w-16 h-16 animate-spin text-primary' />
            </div>
        }>
            <NuqsAdapter>
                <SidebarProvider>
                    {/* 导航栏 */}
                    <AppSidebar />
                    {/* Content */}
                    <SidebarInset className="relative overflow-x-hidden pt-0">
                        {children}
                    </SidebarInset>
                </SidebarProvider>
            </NuqsAdapter>
        </Suspense>
    );
}

export default DashBoardLayout;