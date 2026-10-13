
import "server-only";
import { Client } from "@elastic/elasticsearch";

let client: Client | undefined;

export function getEsClient() {
    if (client) return client;

    const node = process.env.ELASTICSEARCH_URL;
    const username = process.env.ELASTICSEARCH_USERNAME;
    const password = process.env.ELASTICSEARCH_PASSWORD;

    if (!node || !username || !password) {
        throw new Error("Elasticsearch 配置不完整");
    }

    client = new Client({
        node,
        auth: { username, password },
        requestTimeout: 10_000,
        maxRetries: 1,
    });

    return client;
}
