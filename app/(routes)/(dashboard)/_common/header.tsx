"use client";

import React from "react";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RiAddLine, RiHistoryLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
// import { useLocalChat } from "@/hooks/use-localchat";

type HeaderProps = {
    title?: string;
    showActions?: boolean;
};

function Header({ title, showActions = true }: HeaderProps) {
    const router = useRouter();
    // 侧边栏状态
    const { open, isMobile } = useSidebar();
    // const { onToggleHistory } = useLocalChat();

    const onClick = () => {
        router.push("/chat");
    };
    return (
        <header
            className="fixed top-0 inset-0 z-9 h-10
        flex items-center px-2  py-1 bg-background/20 backdrop-blur-sm">
            {(!open || isMobile) && <SidebarTrigger className="h-10" />}
            {!showActions && title && (
                <div
                    className={cn(
                        "pt-5",
                        open && "w-full max-w-full! lg:p-[10px_0_0_250px]"
                    )}
                >
                    <h2 className="text-xl lg:text-2xl font-semibold">{title}</h2>
                </div>
            )}

            {showActions && (
                <div
                    className={cn(
                        "w-full flex items-center justify-between",
                        open && "w-full max-w-full! lg:p-[0_0_0_250px] !"
                    )}
                >
                    <h2>{title}</h2>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer bg-muted/10!"
                            onClick={onClick}
                        >
                            <RiAddLine className="w-8 h-8" />
                            New Chat
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer bg-muted/10 !"
                        // onClick={onToggleHistory}
                        >
                            <RiHistoryLine className="w-8 h-8" />
                            Chat history
                        </Button>
                    </div>
                </div>
            )}
        </header>
    );
};

export default Header;