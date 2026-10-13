/**
 * 知识库解析资源辅助函数。
 * 统一生成图片的 OSS Key、站内访问地址，并校验客户端请求的资源名称。
 */
const KNOWLEDGE_ASSET_URL_PREFIX = "/api/knowledge-documents/"

/** 生成解析图片在 OSS 中的存储 Key。 */
export const getKnowledgeAssetStorageKey = (
  documentId: string,
  assetName: string
) => `knowledge-document-assets/${documentId}/${assetName}`

/** 生成需要经过登录态和文档所有权校验的站内图片地址。 */
export const getKnowledgeAssetUrl = (documentId: string, assetName: string) =>
  `${KNOWLEDGE_ASSET_URL_PREFIX}${documentId}/assets/${encodeURIComponent(assetName)}`

/** 只允许 Worker 生成的 UUID-序号格式图片名，防止目录穿越。 */
export const isSafeKnowledgeAssetName = (value: string) =>
  /^[0-9a-f-]{36}-\d{4}\.(?:png|jpe?g|webp)$/i.test(value)

/** 根据资源扩展名返回响应时使用的 Content-Type。 */
export const getKnowledgeAssetMediaType = (assetName: string) => {
  const extension = assetName.split(".").at(-1)?.toLowerCase()
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "webp") return "image/webp"
  return "image/png"
}

/** 从 parseMetadata 中安全读取当前文档已经保存的图片名。 */
export const getKnowledgeAssetNames = (metadata: unknown) => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return []
  }
  const names = (metadata as Record<string, unknown>).assetNames
  if (!Array.isArray(names)) return []
  return names.filter(
    (name): name is string =>
      typeof name === "string" && isSafeKnowledgeAssetName(name)
  )
}
