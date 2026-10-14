
import { tool } from "ai";
import { z } from "zod";
import { getJson, HttpError } from "../lib/http.js";
import type { VerificationResult } from "../lib/types.js";

type Source = {
  title: string;
  doi: string | null;
  url: string;
  catalog: "crossref" | "openalex";
};

type VerifyInput = {
  doi?: string;
  openAlexId?: string;
  expectedTitle?: string;
};

/** 标准化 DOI 和论文标题，方便比较 */
function normalizeDoi(value?: string | null) {
  if (!value) return null;
  const doi = value.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();

  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

function normalizeTitle(title: string) {
  return title.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** 统一返回核验结果 */
function makeResult(
  status: VerificationResult["status"],
  detail: string,
  source: Source | null = null,
  openAlexId: string | null = null
): VerificationResult {
  return {
    status,
    detail,
    catalog: source?.catalog ?? null,
    doi: source?.doi ?? null,
    openAlexId,
    title: source?.title ?? null,
    url: source?.url ?? null,
    checkedAt: new Date().toISOString(),
    claimSupportVerified: false, // 只核验文献元数据，不核验论文观点
  };
}

/** 核验论文来源，可直接在其他服务中调用 */
export async function verifySourceDirect(
  input: VerifyInput,
  opts: {
    openAlexApiKey?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {}
): Promise<VerificationResult> {
  const doi = normalizeDoi(input.doi);
  const id = input.openAlexId?.trim().toUpperCase() ?? null;

  // 1. 检查 DOI 和 OpenAlex ID 格式
  if (
    (input.doi && !doi) ||
    (id && !/^W\d+$/.test(id)) ||
    (!doi && !id)
  ) {
    return makeResult("mismatch", "请提供有效的 DOI 或 OpenAlex ID");
  }

  try {
    let source: Source;

    if (id) {
      // 2. 使用 OpenAlex ID 查询论文
      const url = new URL(`https://api.openalex.org/works/${id}`);

      if (opts.openAlexApiKey) {
        url.searchParams.set("api_key", opts.openAlexApiKey);
      }

      const paper = await getJson<{
        id?: string;
        title?: string;
        doi?: string | null;
      }>(url, {
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
      });

      // 核对 OpenAlex 返回的论文 ID
      if (!paper.title || paper.id?.split("/").pop() !== id) {
        return makeResult("not_found", "未找到对应论文", null, id);
      }

      const foundDoi = normalizeDoi(paper.doi);

      // 同时提供 DOI 时，检查是否对应同一篇论文
      if (doi && doi !== foundDoi) {
        return makeResult("mismatch", "DOI 与 OpenAlex ID 不匹配", null, id);
      }

      source = {
        title: paper.title,
        doi: foundDoi,
        url: foundDoi
          ? `https://doi.org/${foundDoi}`
          : `https://openalex.org/${id}`,
        catalog: "openalex",
      };
    } else {
      // 3. 只有 DOI 时，通过 Crossref 核验
      const url = new URL(
        `https://api.crossref.org/works/${encodeURIComponent(doi!)}`
      );

      const data = await getJson<{
        message?: {
          title?: string[];
          DOI?: string;
          URL?: string;
        };
      }>(url, {
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
      });

      const paper = data.message;

      if (!paper?.title?.[0] || normalizeDoi(paper.DOI) !== doi) {
        return makeResult("not_found", "未找到对应论文");
      }

      source = {
        title: paper.title[0],
        doi,
        url: paper.URL ?? `https://doi.org/${doi}`,
        catalog: "crossref",
      };
    }

    // 4. 如果提供了预期标题，进一步核对标题
    if (
      input.expectedTitle &&
      normalizeTitle(input.expectedTitle) !== normalizeTitle(source.title)
    ) {
      return makeResult("mismatch", "论文标题不匹配", source, id);
    }

    // 5. 书目信息核验成功
    return makeResult(
      "verified",
      "论文书目信息已核验，但尚未验证正文是否支持具体观点",
      source,
      id
    );
  } catch (error) {
    opts.signal?.throwIfAborted();

    // 404 表示目录中没有找到，其他请求异常表示暂时无法核验
    const notFound = error instanceof HttpError && error.status === 404;

    return makeResult(
      notFound ? "not_found" : "unavailable",
      notFound ? "未找到论文记录" : "论文来源核验失败，请稍后重试",
      null,
      id
    );
  }
}

/** 创建一个文献来源核验工具，供 Agent 使用 */
export function createVerifySourceTool(
  options: {
    openAlexApiKey?: string;
    fetchImpl?: typeof fetch;
  } = {}
) {
  return tool({
    description:
      "通过 DOI 或 OpenAlex ID 核验学术论文是否存在，并检查标题及标识符是否匹配。仅核验书目信息，不代表论文支持某项研究结论。",

    inputSchema: z.object({
      doi: z.string().max(300).optional()
        .describe("论文 DOI，例如 10.1145/..."),

      openAlexId: z.string().max(32).optional()
        .describe("OpenAlex 论文 ID，例如 W1234567890"),

      expectedTitle: z.string().max(600).optional()
        .describe("需要核对的论文标题"),
    }).refine(
      (input) => !!(input.doi || input.openAlexId),
      "必须提供 DOI 或 OpenAlex ID"
    ),

    execute: (input, { abortSignal }) =>
      verifySourceDirect(input, {
        ...options,
        signal: abortSignal,
      }),
  });
}
