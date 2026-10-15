/** 每个研究任务独立创建；合并相同请求，失败或取消后允许重试。 */
export function createSuccessfulRequestCache<T extends { success: boolean }>() {
  const requests = new Map<string, Promise<T>>()
  return {
    run(key: string, execute: () => Promise<T>): Promise<T> {
      const previous = requests.get(key)
      if (previous) return previous
      const pending = Promise.resolve()
        .then(execute)
        .then(
          (result) => {
            if (!result.success) requests.delete(key)
            return result
          },
          (error) => {
            requests.delete(key)
            throw error
          }
        )
      requests.set(key, pending)
      return pending
    },
  }
}
