"use client";
import {
    RiScanLine,
    RiChatAiLine,
    RiSettings3Line,
} from "@remixicon/react";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarTrigger,
} from "../ui/sidebar";
import Logo from "@/components/logo/index"; // path to your logo component
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthToken } from "@/hooks/use-auth-token";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import NavMenu from "@/components/sidebar/nav-menu";
import NavUser from "@/components/sidebar/nav-user";
import NavNotes from "@/components/sidebar/nav-notes";
// import ModeToggle from "@/components/mode-toggle";
// import NoteDialog from "@/components/note-dialog";
// 菜单项
const navMenu = [
    {
        title: "仪表盘",
        url: "/home",
        icon: RiScanLine,
    },
    {
        title: "新建对话",
        url: "/chat",
        icon: RiChatAiLine,
    },
    {
        title: "设置",
        url: "/settings",
        icon: RiSettings3Line,
    },
];
function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    const router = useRouter();
    // 清除认证令牌的函数
    const { clearBearerToken } = useAuthToken();
    // 退出登录状态
    const [isSigningOut, setIsSigningOut] = useState<boolean>(false);
    // Better Auth 认证客户端 Hook
    const { useSession, signOut } = authClient;
    const { data: session, isPending: isLoading } = useSession();

    const user = session?.user;
    // 用户信息
    const userInfo = {
        name: user?.name || "",
        email: user?.email || ""
    };
    // 退出登录处理函数
    const handleLogout = () => {
        if (isSigningOut) return;
        setIsSigningOut(true);
        // 退出登录
        signOut({
            fetchOptions: {
                onSuccess: () => {
                    // 退出登录成功后，清除认证令牌并重定向到登录页
                    clearBearerToken();
                    router.push("/auth/sign-in");
                    setIsSigningOut(false);
                },
                onError: (ctx) => {
                    setIsSigningOut(false);
                    toast.error(ctx.error.message);
                },
            },
        });
    };

    return (

        <>
            {/* <NoteDialog /> */}
            <Sidebar className="z-99" {...props}>
                {/* 导航栏头部 */}
                <SidebarHeader>
                    <div className="w-full flex items-center justify-between">
                        <Logo url="/home" />
                        <SidebarTrigger className="-ms-4" />
                    </div>
                    {/* 分割线 */}
                    <hr className="border-border mx-2 -mt-px" />
                    {/* {Search Button} */}
                </SidebarHeader>
                {/* 导航栏内容 */}
                <SidebarContent className="px-2 pt-2 overflow-x-hidden">
                    {/* 导航菜单 */}
                    <NavMenu menus={navMenu} />
                    {/* 笔记列表 */}
                    <NavNotes />

                </SidebarContent>
                {/* 导航栏底部 */}
                <SidebarFooter>
                    <hr className="border-border mx-2 -mt-px" />
                    {/* 底部用户信息栏 */}
                    <NavUser
                        isLoading={isLoading}
                        user={userInfo}
                        isSigningOut={isSigningOut}
                        onSignOut={handleLogout}
                    />
                </SidebarFooter>
            </Sidebar>
        </>
    );
}

export default AppSidebar;
