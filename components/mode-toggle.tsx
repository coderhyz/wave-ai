"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export default function ModeToggle() {
    // 使用 useTheme 钩子来获取 setTheme 函数，以便在用户选择主题时调用它来切换主题
    const { setTheme } = useTheme()

    return (
        <DropdownMenu>
            {/* 触发器 */}
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                    <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
                    <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
                    <span className="sr-only">Toggle theme</span>
                </Button>
            </DropdownMenuTrigger>
            {/* 下拉菜单内容 */}
            <DropdownMenuContent align="start" side="right" sideOffset={8} className="min-w-40 rounded-lg">
                <DropdownMenuItem onClick={() => setTheme("light")}>
                    光亮
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                    暗黑
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                    系统
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
