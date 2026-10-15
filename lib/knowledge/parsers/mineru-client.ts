/**
 * MinerU Precision API 客户端。
 * 完成申请上传地址、上传原文件、轮询任务、下载结果 ZIP 和读取 full.md。
 */
import JSZip from "jszip"
import { setTimeout as sleep } from "node:timers/promises"
import { KnowledgeParseError } from "@/lib/knowledge/parsers/types"

/** MinerU 转换完成后交给本地适配层的数据。 */
export type MineruResult = {
  markdown: string
  archive: JSZip
  rootPath: string
  batchId: string
  modelVersion: string
}

/**
 * 将 PDF 或 DOCX 提交给 MinerU，并等待 Markdown 结果。
 * API 地址、Token、模型、语言和超时均从服务端环境变量读取。
 */
export async function parseWithMineru(
  input: Buffer,
  filename: string,
  abortSignal?: AbortSignal
): Promise<MineruResult> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(Number(process.env.MINERU_TIMEOUT_MS ?? 480000)),
    ...(abortSignal ? [abortSignal] : []),
  ])
  signal.throwIfAborted()
  // 统一去除 base URL 末尾斜杠，避免拼接出双斜杠。
  const baseUrl = (
    process.env.MINERU_API_BASE_URL ?? "https://mineru.net"
  ).replace(/\/$/, "")
  const token = process.env.MINERU_API_TOKEN
  const modelVersion = process.env.MINERU_MODEL_VERSION ?? "vlm"
  if (!token) throw new Error("MINERU_API_TOKEN is not configured")

  // 第一步：申请一次性文件上传地址，同时创建批量任务。
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
  const createdResponse = await fetch(`${baseUrl}/api/v4/file-urls/batch`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      files: [{ name: filename }],
      model_version: modelVersion,
      language: process.env.MINERU_LANGUAGE ?? "ch",
      enable_table: true,
      enable_formula: true,
    }),
  })
  signal.throwIfAborted()
  const created = await createdResponse.json()
  signal.throwIfAborted()
  if (!createdResponse.ok || created.code !== 0) {
    throw new KnowledgeParseError(
      "PARSE_FAILED",
      `MinerU 创建任务失败：${created.msg ?? createdResponse.statusText}`,
      400,
      true
    )
  }

  // 第二步：将内存中的原文件直接 PUT 到 MinerU 返回的签名地址。
  const batchId = created.data.batch_id as string
  const uploadUrl = created.data.file_urls[0] as string
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    body: new Uint8Array(input),
    signal,
  })
  signal.throwIfAborted()
  if (!uploadResponse.ok) {
    throw new KnowledgeParseError(
      "PARSE_FAILED",
      "MinerU 文件上传失败",
      400,
      true
    )
  }

  // 第三步：按照环境变量配置的间隔轮询任务结果。
  const interval = Number(process.env.MINERU_POLL_INTERVAL_MS ?? 3000)
  let resultZipUrl = ""

  while (true) {
    signal.throwIfAborted()
    const statusResponse = await fetch(
      `${baseUrl}/api/v4/extract-results/batch/${batchId}`,
      { headers, signal }
    )
    signal.throwIfAborted()
    const status = await statusResponse.json()
    signal.throwIfAborted()
    const result = status.data?.extract_result?.[0]

    if (result?.state === "done") {
      resultZipUrl = result.full_zip_url
      break
    }
    if (result?.state === "failed") {
      throw new KnowledgeParseError(
        "PARSE_FAILED",
        `MinerU 解析失败：${result.err_msg ?? "未知错误"}`
      )
    }
    await sleep(interval, undefined, { signal }).catch((error: unknown) => {
      signal.throwIfAborted()
      throw error
    })
  }

  // 第四步：下载结果压缩包，找到 MinerU 输出的 full.md。
  if (!resultZipUrl) {
    throw new KnowledgeParseError(
      "PARSE_FAILED",
      "MinerU 未返回解析结果下载地址",
      400,
      true
    )
  }
  const zipResponse = await fetch(resultZipUrl, { signal })
  signal.throwIfAborted()
  const archive = await JSZip.loadAsync(await zipResponse.arrayBuffer())
  signal.throwIfAborted()
  const markdownFile = Object.values(archive.files).find(
    (file) => !file.dir && /(^|\/)full\.md$/i.test(file.name)
  )
  if (!markdownFile) {
    throw new KnowledgeParseError("PARSE_FAILED", "MinerU 未返回 Markdown")
  }

  const markdown = await markdownFile.async("string")
  signal.throwIfAborted()

  // rootPath 用于从 ZIP 中定位 Markdown 引用的相对图片路径。
  return {
    markdown,
    archive,
    rootPath: markdownFile.name.slice(
      0,
      markdownFile.name.lastIndexOf("/") + 1
    ),
    batchId,
    modelVersion,
  }
}
