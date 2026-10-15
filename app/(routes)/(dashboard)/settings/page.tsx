"use client"

import { useSyncExternalStore } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import Header from "@/app/(routes)/(dashboard)/_common/header"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const subscribe = () => () => {}

export default function Settings() {
  const { theme, setTheme } = useTheme()
  // 本地保存的主题仅在客户端可用，首次渲染保持与服务端一致。
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )

  return (
    <main className="min-h-dvh w-full pt-13">
      <Header title="设置" />
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8 md:py-12">
        <h1
          id="appearance-title"
          className="text-2xl font-semibold tracking-tight"
        >
          外观设置
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          选择适合你的界面主题。
        </p>

        <form aria-labelledby="appearance-title" className="mt-6">
          <Card>
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
              <div className="space-y-2">
                <Label htmlFor="theme">界面主题</Label>
                <p
                  id="theme-description"
                  className="text-sm text-muted-foreground"
                >
                  跟随系统时，将自动匹配设备的浅色或深色模式。
                </p>
              </div>
              <Select
                value={mounted ? (theme ?? "system") : ""}
                onValueChange={setTheme}
                disabled={!mounted}
              >
                <SelectTrigger
                  id="theme"
                  aria-describedby="theme-description"
                  className="w-full shrink-0 sm:w-44"
                >
                  <SelectValue placeholder="加载主题…" />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="light">
                    <Sun aria-hidden="true" />
                    浅色
                  </SelectItem>
                  <SelectItem value="dark">
                    <Moon aria-hidden="true" />
                    深色
                  </SelectItem>
                  <SelectItem value="system">
                    <Monitor aria-hidden="true" />
                    跟随系统
                  </SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
            <CardFooter className="border-t text-xs text-muted-foreground">
              更改即时生效，主题偏好会自动保存在当前浏览器。
            </CardFooter>
          </Card>
        </form>
      </div>
    </main>
  )
}
