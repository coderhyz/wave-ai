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
      timeout: 30_000,
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
