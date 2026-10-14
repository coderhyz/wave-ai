
import { tool } from "ai";
import { z } from "zod";
import { getJson } from "../lib/http.js";
import type { Paper } from "../lib/types.js";

/**
 * OpenAlex 返回的论文数据结构
 * 只定义实际使用的字段，避免维护完整的 API 类型。
 */
type Work = {
  id?: string;                          // OpenAlex 论文 ID
  title?: string;                       // 论文标题
  doi?: string | null;                  // DOI 标识符
  publication_year?: number;            // 发表年份

  authorships?: {
    author?: { display_name?: string };
  }[];

  primary_location?: {
    landing_page_url?: string;          // 论文详情页
    pdf_url?: string;                   // PDF 链接
    source?: { display_name?: string }; // 期刊或会议名称
  } | null;

  best_oa_location?: {
    pdf_url?: string;                   // 最佳开放获取 PDF
  } | null;

  cited_by_count?: number;              // 被引用次数

  // OpenAlex 使用倒排索引存储摘要
  abstract_inverted_index?: Record<string, number[]> | null;
};

/**
 * 将 OpenAlex 的摘要倒排索引还原为普通文本。
 *
 * 原始格式：
 * {
 *   "Deep": [0],
 *   "learning": [1],
 *   "is": [2],
 *   "useful": [3]
 * }
 *
 * 还原结果：
 * "Deep learning is useful"
 */
function parseAbstract(index?: Record<string, number[]> | null) {
  if (!index) return null;

  return (
    Object.entries(index)
      // 将单词和对应位置展开
      .flatMap(([word, positions]) =>
        positions.map((position) => ({ word, position })),
      )
      // 按照原始位置排序
      .sort((a, b) => a.position - b.position)
      // 提取单词并拼接为完整摘要
      .map(({ word }) => word)
      .join(" ")
      // 限制摘要长度，减少 Agent 的上下文消耗
      .slice(0, 1200) || null
  );
}

/**
 * 将 OpenAlex 数据转换为项目统一的 Paper 类型。
 *
 * 作用：
 * 1. 提取论文 ID 和 DOI
 * 2. 整理作者、年份和发表来源
 * 3. 还原摘要
 * 4. 提取论文详情页和 PDF 链接
 */
function toPaper(work: Work): Paper | null {
  // OpenAlex ID 示例：https://openalex.org/W123456789
  const id = work.id?.split("/").pop();

  // 缺少 ID 或标题时，跳过该论文
  if (!id || !work.title) return null;

  // DOI 示例：https://doi.org/10.1234/abc
  // 转换为：10.1234/abc
  const doi =
    work.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") || null;

  return {
    openAlexId: id,
    title: work.title,
    doi,
    year: work.publication_year ?? null,

    // 提取作者姓名，最多保留 8 位
    authors:
      work.authorships
        ?.map((item) => item.author?.display_name)
        .filter((name): name is string => !!name)
        .slice(0, 8) ?? [],

    // 期刊或会议名称
    venue: work.primary_location?.source?.display_name ?? null,

    // 还原论文摘要
    abstract: parseAbstract(work.abstract_inverted_index),

    // 论文被引用次数
    citedByCount: work.cited_by_count ?? 0,

    // 优先使用论文详情页，否则使用 DOI 或 OpenAlex 页面
    landingPageUrl:
      work.primary_location?.landing_page_url ??
      (doi ? `https://doi.org/${doi}` : work.id!),

    // 优先使用开放获取 PDF
    pdfUrl:
      work.best_oa_location?.pdf_url ??
      work.primary_location?.pdf_url ??
      null,
  };
}

/**
 * 创建 AI SDK 论文检索工具。
 *
 * 数据来源：OpenAlex API
 * API 文档：https://docs.openalex.org/
 *
 * 用途：
 * - 根据关键词搜索学术论文
 * - 筛选指定年份范围
 * - 按相关性或引用量排序
 * - 返回论文的基本信息和摘要
 *
 * options:
 * - openAlexApiKey：OpenAlex API Key
 * - fetchImpl：可选的自定义 fetch，方便单元测试
 */
export function createSearchPapersTool(
  options: {
    openAlexApiKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
) {
  return tool({
    // 告诉大模型这个工具的用途
    description:
      "搜索真实学术论文，返回标题、作者、年份、摘要、DOI 和论文链接。适用于文献调研、相关工作检索和深度研究。",

    // 使用 Zod 定义大模型调用工具时的输入参数
    inputSchema: z.object({
      query: z.string().min(3).describe("论文检索关键词"),

      yearFrom: z.number().int().optional().describe("起始年份"),

      yearTo: z.number().int().optional().describe("结束年份"),

      limit: z.number().int().min(1).max(15).default(8)
        .describe("返回论文数量"),

      sort: z.enum(["relevance", "cited"]).default("relevance")
        .describe("排序方式：相关性或引用量"),
    }),

    /**
     * 工具执行函数。
     *
     * AI SDK 会将模型生成的参数传入 execute。
     * abortSignal 用于在请求取消时中断网络调用。
     */
    execute: async (
      { query, yearFrom, yearTo, limit, sort },
      { abortSignal },
    ) => {
      try {
        // 1. 创建 OpenAlex API 请求地址
        const url = new URL("https://api.openalex.org/works");

        // 2. 设置检索关键词和返回数量
        url.searchParams.set("search", query);
        url.searchParams.set("per_page", String(limit));

        // 3. 构建年份筛选条件
        const filters = [
          yearFrom && `from_publication_date:${yearFrom}-01-01`,
          yearTo && `to_publication_date:${yearTo}-12-31`,
        ].filter(Boolean);

        if (filters.length) {
          url.searchParams.set("filter", filters.join(","));
        }

        // 4. 如果选择 cited，则按引用量从高到低排序
        if (sort === "cited") {
          url.searchParams.set("sort", "cited_by_count:desc");
        }

        // 5. 设置 OpenAlex API Key
        if (options.openAlexApiKey) {
          url.searchParams.set("api_key", options.openAlexApiKey);
        }

        // 6. 发送 HTTP 请求并解析 JSON
        const data = await getJson<{
          meta?: { count?: number };
          results?: Work[];
        }>(url, {
          signal: abortSignal,
          fetchImpl: options.fetchImpl,
        });

        // 7. 将 OpenAlex 原始数据转换为统一 Paper 类型
        const papers = (data.results ?? [])
          .map(toPaper)
          .filter((paper): paper is Paper => paper !== null);

        // 8. 返回结果给 AI SDK，由 Agent 继续分析
        return {
          ok: true,
          query,
          totalMatches: data.meta?.count ?? papers.length,
          papers,
          provider: "openalex",
        };
      } catch (error) {
        // 请求异常时返回错误信息，避免工具直接抛出异常
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "论文检索失败",
          papers: [] as Paper[],
        };
      }
    },
  });
}
