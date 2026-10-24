import "server-only"

import OSS from "ali-oss"

let ossClient: OSS | undefined

const requireEnv = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少 OSS 环境变量：${name}`)
  return value
}

/** 只在服务端首次访问附件时创建客户端，避免构建阶段读取运行时密钥。 */
export const getOssClient = () => {
  if (!ossClient) {
    ossClient = new OSS({
      region: requireEnv("OSS_REGION"),
      accessKeyId: requireEnv("OSS_ACCESS_KEY_ID"),
      accessKeySecret: requireEnv("OSS_ACCESS_KEY_SECRET"),
      bucket: requireEnv("OSS_BUCKET"),
      secure: true,
      // 给部署环境与 OSS 之间的文件传输留出时间，避免 30 秒提前超时。
      timeout: 120_000,
      authorizationV4: true,
    })
  }
  return ossClient
}

export const putOssObject = async (
  storageKey: string,
  content: Buffer,
  mediaType: string
) => {
  await getOssClient().put(storageKey, content, {
    mime: mediaType,
    headers: { "Cache-Control": "private, max-age=31536000, immutable" },
  })
}

export const getOssObject = async (storageKey: string): Promise<Buffer> => {
  const result = await getOssClient().get(storageKey)
  if (!result.content) throw new Error("OSS 返回了空的附件内容")
  return Buffer.isBuffer(result.content)
    ? result.content
    : Buffer.from(result.content)
}

export const deleteOssObject = async (storageKey: string) => {
  await getOssClient().delete(storageKey)
}

/** 使用现有客户端签发只读 URL；不签入 Range，允许 PDF 阅读器自行请求字节范围。 */
export const getOssPreviewUrl = (storageKey: string, expires: number) =>
  getOssClient().signatureUrlV4(
    "GET",
    expires,
    {
      queries: {
        "response-content-disposition": "inline",
        "response-cache-control": "private, no-store",
      },
    },
    storageKey
  )
