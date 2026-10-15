import "server-only"
import { Client } from "@elastic/elasticsearch"

let client: Client | undefined

export function getEsClient() {
  if (client) return client

  const node = process.env.ELASTICSEARCH_URL
  const username = process.env.ELASTICSEARCH_USERNAME
  const password = process.env.ELASTICSEARCH_PASSWORD

  if (!node || !username || !password) {
    throw new Error("Elasticsearch 配置不完整")
  }

  const requestTimeout = Number(
    process.env.ELASTICSEARCH_REQUEST_TIMEOUT_MS ?? 10_000
  )
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout <= 0) {
    throw new Error("ELASTICSEARCH_REQUEST_TIMEOUT_MS 必须是正整数，单位为毫秒")
  }

  client = new Client({
    node,
    auth: { username, password },
    requestTimeout,
    maxRetries: 1,
  })

  return client
}
