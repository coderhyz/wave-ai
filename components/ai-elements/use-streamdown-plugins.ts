"use client"

import { useEffect, useMemo, useState } from "react"
import { cjk } from "@streamdown/cjk"
import type { PluginConfig } from "streamdown"

/**
 * CJK 插件体积较小，并且每条中文消息都需要，因此仍然放在基础包中。
 * 代码高亮、数学公式和 Mermaid 体积更大，下面会根据消息内容动态加载。
 */
const basePlugins: PluginConfig = { cjk }

/**
 * Promise 放在模块作用域，相当于一份页面级缓存。
 * 多条消息同时需要同一个插件时，只会触发一次 import() 和网络请求。
 */
let codePluginPromise: ReturnType<typeof loadCodePlugin> | undefined
let mathPluginPromise: ReturnType<typeof loadMathPlugin> | undefined
let mermaidPluginPromise: ReturnType<typeof loadMermaidPlugin> | undefined

/** 动态 import 会让 Next.js 把每个重型插件拆成独立 Chunk。 */
function loadCodePlugin() {
  return import("@streamdown/code").then(({ code }) => code)
}

function loadMathPlugin() {
  return import("@streamdown/math").then(({ createMathPlugin }) =>
    createMathPlugin({ singleDollarTextMath: true })
  )
}

function loadMermaidPlugin() {
  return import("@streamdown/mermaid").then(({ mermaid }) => mermaid)
}

/**
 * 重型 Markdown 能力按内容加载：普通对话不会下载代码高亮、KaTeX 或 Mermaid。
 * 流式输出一旦出现对应语法，插件会异步到达并触发一次增强渲染。
 */
export function useStreamdownPlugins(content: string): PluginConfig {
  /**
   * 只做轻量正则检测，不在渲染阶段加载插件：
   * - ``` 或 ~~~ 表示围栏代码块；
   * - $...$、$$...$$、\(...\) 或 \[...\] 表示数学公式；
   * - ```mermaid 表示 Mermaid 图表。
   *
   * 流式消息每次增长都会执行 Hook，useMemo 保证只有内容变化时才重新检测。
   */
  const requirements = useMemo(
    () => ({
      code: /(?:^|\n)\s*(?:```|~~~)/.test(content),
      math: /\$\$[\s\S]*?\$\$|(^|[^\\$])\$(?!\$)[^\n$]+\$(?!\$)|\\\(|\\\[/.test(
        content
      ),
      mermaid: /(?:^|\n)\s*(?:```|~~~)mermaid\b/i.test(content),
    }),
    [content]
  )

  /** 首次渲染只有 CJK；重型插件下载完成后再合并进来并触发增强渲染。 */
  const [plugins, setPlugins] = useState<PluginConfig>(basePlugins)

  useEffect(() => {
    /**
     * 动态加载完成前组件可能因切换会话或删除消息而卸载。
     * active 用于阻止卸载后的异步回调继续更新 React 状态。
     */
    let active = true

    /** 收集当前消息真正需要加载的插件任务。 */
    const pending: Promise<Partial<PluginConfig>>[] = []

    if (requirements.code) {
      /** ??= 表示只有第一次命中代码块时才创建并缓存加载 Promise。 */
      codePluginPromise ??= loadCodePlugin()
      pending.push(codePluginPromise.then((code) => ({ code })))
    }
    if (requirements.math) {
      mathPluginPromise ??= loadMathPlugin()
      pending.push(mathPluginPromise.then((math) => ({ math })))
    }
    if (requirements.mermaid) {
      mermaidPluginPromise ??= loadMermaidPlugin()
      pending.push(mermaidPluginPromise.then((mermaid) => ({ mermaid })))
    }

    /** 普通文本不启动任何动态请求，继续使用基础插件。 */
    if (pending.length === 0) {
      return () => {
        active = false
      }
    }

    /**
     * 等当前消息所需插件全部到达后，一次性合并，避免连续多次 setState。
     * 下一次渲染时 Streamdown 会用完整插件重新处理当前 Markdown。
     */
    void Promise.all(pending).then((loadedPlugins) => {
      if (active) setPlugins(Object.assign({}, basePlugins, ...loadedPlugins))
    })

    /** useEffect 清理函数：内容变化或组件卸载时，让旧异步任务失效。 */
    return () => {
      active = false
    }
  }, [requirements.code, requirements.math, requirements.mermaid])

  /** 消息组件和思考过程组件把这里返回的配置传给 Streamdown。 */
  return plugins
}
