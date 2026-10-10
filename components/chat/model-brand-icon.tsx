"use client"

import { DeepSeek, Qwen } from "@lobehub/icons"
import { BrainCircuit } from "lucide-react"
import { chatModels } from "@/lib/ai/model"
import { cn } from "@/lib/utils"

interface ModelBrandIconProps {
  modelId?: string | null
  size?: number
  className?: string
}

/** 品牌映射来自模型配置，未知历史模型回退为通用图标。 */
export function ModelBrandIcon({
  modelId,
  size = 16,
  className,
}: ModelBrandIconProps) {
  const brand = chatModels.find((model) => model.id === modelId)?.brand

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center align-middle",
        className
      )}
    >
      {brand === "deepseek" ? (
        <DeepSeek.Color size={size} />
      ) : brand === "qwen" ? (
        <Qwen.Color size={size} />
      ) : (
        <BrainCircuit style={{ width: size, height: size }} />
      )}
    </span>
  )
}
