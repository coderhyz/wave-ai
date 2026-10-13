export const MAX_DOCUMENT_PARSE_TIME_MS = Number(
  process.env.MINERU_TIMEOUT_MS ?? 8 * 60 * 1000
)
// 租约比解析超时多两分钟，为索引落库及资源清理预留时间。
export const DOCUMENT_JOB_LEASE_MS = MAX_DOCUMENT_PARSE_TIME_MS + 2 * 60 * 1000
