export const MAX_DOCUMENT_PARSE_TIME_MS = Number(
  process.env.MINERU_TIMEOUT_MS ?? 8 * 60 * 1000
)
// 完整请求比解析多预留两分钟；补偿清理和中断恢复沿用该安全窗口。
export const DOCUMENT_PROCESSING_TIMEOUT_MS =
  MAX_DOCUMENT_PARSE_TIME_MS + 2 * 60 * 1000
