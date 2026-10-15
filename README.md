# Wave AI

**连接你的知识，探索更深的答案。**

Wave AI 是一个集 AI 对话、个人知识库与深度研究于一体的 Web 应用。你可以与大模型自然交流，将 PDF、Word、Markdown 和文本资料整理为个人知识库，再结合知识库检索与网页搜索完成文档问答、信息整理和专题研究。

项目使用中文界面，支持流式回答、会话历史和引用来源展示，适合个人学习、资料管理与研究辅助。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| AI 对话 | 接入 DeepSeek、通义千问模型，支持流式输出、停止生成、重新生成及会话历史管理。 |
| 聊天附件 | 支持图片和文档附件；图片输入根据模型能力选择视觉模型，文本类附件解析后用于问答。 |
| 个人知识库 | 创建知识库与多级目录，上传、预览、下载、重命名、删除和重新解析文档。 |
| 文档问答 | 在文档预览中围绕当前文档提问，也可在普通对话中由工具检索自己的知识库。 |
| 混合检索 | 结合 PostgreSQL 向量召回和 Elasticsearch 关键词召回，通过 RRF 融合，并支持模型重排。 |
| 联网搜索 | 使用 Tavily 获取网页搜索结果，为回答提供外部参考资料。 |
| 深度研究 | 按照规划、检索与阅读、覆盖评估、报告生成的流程研究问题，支持不同研究深度和来源范围。 |
| 引用溯源 | 展示知识库引用片段、正文版本及文档入口；研究报告保留网页来源和已收集的证据。 |
| 账号与主题 | 邮箱密码注册、登录及用户数据隔离；支持浅色、深色和跟随系统主题。 |

知识库目前支持 **PDF、DOCX、TXT、Markdown**，单个原文件最大 **20 MB**。PDF、DOCX 通过 MinerU 解析，TXT、Markdown 使用本地解析器。聊天附件有独立的格式和大小限制。

## 技术栈

| 层级 | 技术与用途 |
| --- | --- |
| Web 框架 | Next.js 16、React 19、TypeScript，使用 App Router 组织页面与服务端接口。 |
| 界面 | Tailwind CSS 4、shadcn/ui、Radix UI、Lucide；next-themes 管理主题。 |
| 数据与状态 | TanStack Query 管理远程数据，Zustand 管理共享界面状态，React Hook Form 与 Zod 处理表单和校验。 |
| API 与认证 | Hono、Hono RPC、Zod Validator、Better Auth。 |
| AI 与流式交互 | Vercel AI SDK 7，接入 DeepSeek、通义千问；使用 SDK 的消息流和工具调用能力。 |
| 数据库 | PostgreSQL、Prisma 6；pgvector 保存文档向量，数据库迁移包含 pg_trgm 扩展。 |
| 关键词检索 | Elasticsearch，使用 BM25 和内置 CJK 分析器。 |
| 文档与存储 | 阿里云 OSS 保存原文件和解析图片，MinerU 处理 PDF、DOCX，LangChain Text Splitters 参与文本分块。 |
| 向量与重排 | 百炼 `text-embedding-v4`，使用 1024 维向量；可选 `qwen3-rerank` 重排。 |
| 网页资料 | Tavily Search 和网页内容提取。 |
| 工程检查 | Vitest、ESLint、Prettier、TypeScript。 |

## 核心处理流程

### 文档入库

```mermaid
flowchart LR
  A[上传文件] --> B[类型、大小与权限校验]
  B --> C[原文件保存到 OSS]
  C --> D[解析为 Markdown]
  D --> E[正文与定位信息保存到 PostgreSQL]
  E --> F[分块与向量化]
  F --> G[写入 Elasticsearch 关键词索引]
  G --> H[提交 PostgreSQL 分块、向量和就绪状态]
```

上传和重新解析会在当前请求中等待处理完成，日常运行只需要 Web/API 服务，**不需要常驻文档 Worker**。MinerU 的远程任务状态检查只发生在当前文件的处理期间；应用没有空闲数据库轮询，也没有前端定时状态轮询。

解析状态与索引状态分别保存，索引失败时保留已保存的正文。删除文档、目录或知识库后立即尝试清理 OSS 和 Elasticsearch 资源；未完成的资源清单持久化保存，供一次性维护命令补偿。

### 检索与回答

```mermaid
flowchart LR
  A[用户问题] --> B[按用户权限和文档版本限定范围]
  B --> C[PostgreSQL 向量召回]
  B --> D[Elasticsearch 关键词召回]
  C --> E[RRF 融合]
  D --> E
  E --> F[可选模型重排]
  F --> G[模型生成回答]
  G --> H[展示引用片段与来源]
```

深度研究在此基础上按来源范围使用知识库检索、网页搜索和网页正文读取，再评估证据覆盖情况并生成报告。搜索摘要、网页正文和知识库片段分别记录；证据不足或研究未完成时保留相应状态，不将搜索摘要视为已经核实的正文证据。

## 本地运行

### 1. 准备环境

- Node.js **22 或更高版本**及 npm。
- 可连接的 PostgreSQL，支持安装 `vector` 和 `pg_trgm` 扩展。
- 可连接的 Elasticsearch，当前使用 8.x 客户端。
- 阿里云 OSS Bucket 与访问凭证。
- 模型服务凭证；使用网页搜索、PDF/DOCX 解析时，还需分别配置 Tavily、MinerU。

数据库和 Elasticsearch 可以使用已有服务器，不要求安装在运行 Web 应用的同一台机器上。

### 2. 安装依赖

拉取仓库后，在项目根目录执行：

```bash
npm ci
```

安装时会通过 `postinstall` 自动生成 Prisma Client；若禁用了安装脚本，需自行执行 `npx prisma generate`。

### 3. 配置环境变量

在根目录创建 `.env`。以下仅为配置模板，需替换为自己的服务地址和凭证；不要提交真实密钥。

```dotenv
# 数据库与认证
DATABASE_URL="postgresql://your_user:your_password@your_pg_host:5432/your_database?sslmode=require"
BETTER_AUTH_SECRET="replace-with-a-random-secret-of-at-least-32-characters"
BETTER_AUTH_URL="http://localhost:3000"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# 大模型：DeepSeek 用于聊天、会话标题及上下文压缩
DEEPSEEK_API_KEY="your_deepseek_api_key"
# 千问 Key 同时用于千问聊天、文档向量化和可选重排
QWEN_API_KEY="your_qwen_api_key"

# Elasticsearch
ELASTICSEARCH_URL="https://your_elasticsearch_host:9200"
ELASTICSEARCH_USERNAME="your_elasticsearch_username"
ELASTICSEARCH_PASSWORD="your_elasticsearch_password"

# 阿里云 OSS
OSS_REGION="oss-cn-hangzhou"
OSS_BUCKET="your_oss_bucket"
OSS_ACCESS_KEY_ID="your_oss_access_key_id"
OSS_ACCESS_KEY_SECRET="your_oss_access_key_secret"

# PDF / DOCX 解析
MINERU_API_BASE_URL="https://mineru.net"
MINERU_API_TOKEN="your_mineru_api_token"
MINERU_MODEL_VERSION="vlm"
MINERU_LANGUAGE="ch"
MINERU_TIMEOUT_MS=480000
MINERU_POLL_INTERVAL_MS=3000

# 联网搜索与网页正文提取
TAVILY_API_KEY="your_tavily_api_key"

# 示例先关闭可选重排，使用 RRF 排序
RAG_RERANK_ENABLED=false
```

重排在代码中默认开启。需要启用时，设置 `RAG_RERANK_ENABLED=true`，并补充与百炼业务空间匹配的 HTTPS 接口地址 `RAG_RERANK_URL`；可通过 `RAG_RERANK_MODEL` 和 `RAG_RERANK_MIN_SCORE` 调整模型及阈值。重排失败时返回警告并保留 RRF 排序。

设置页目前只提供主题配置，API Key 通过服务端环境变量管理。修改 `.env` 后需重启服务；`NEXT_PUBLIC_APP_URL` 会用于客户端构建，部署时应在构建前配置正确。

### 4. 初始化或同步数据库

先确认 `DATABASE_URL` 指向的环境，再查看迁移状态和待执行 SQL：

```bash
npx prisma validate
npx prisma migrate status
npx prisma migrate deploy
npx prisma generate
```

`migrate deploy` 会执行仓库中尚未应用的迁移，实际修改数据库。已有数据应先备份；执行迁移的数据库账号需要相应权限，或由管理员预先安装扩展。只运行 `prisma generate` 不会更新数据库表结构。

### 5. 启动开发服务

```bash
npm run dev
```

默认访问 `http://localhost:3000`：

| 路径 | 页面 |
| --- | --- |
| `/` | 中文项目介绍页；已登录用户跳转到对话页。 |
| `/auth/sign-up` | 注册账号。 |
| `/auth/sign-in` | 登录账号。 |
| `/chat` | AI 对话与深度研究。 |
| `/home` | 知识库、目录与文档管理。 |
| `/settings` | 界面主题设置。 |

Windows PowerShell 如遇脚本执行策略限制，可使用 `npm.cmd`、`npx.cmd` 替代 `npm`、`npx`。

## 检查与维护

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

| 维护命令 | 作用与执行条件 |
| --- | --- |
| `npm run reindex:documents` | 对已有 READY 正文逐篇重建索引，实际调用向量模型及 Elasticsearch，完成后退出。 |
| `npm run cleanup:documents` | 一次性处理已登记的资源清理清单，会删除对应 OSS 对象和 ES 分块；失败或尚未到安全时间的记录保留。 |
| `npm run recover:documents -- --offline` | 停止所有连接同一数据库的 Web/API 实例与旧 Worker 后，恢复中断状态并退役旧解析任务；不自动重新解析。 |
| `npm run db:studio` | 打开 Prisma Studio，查看或编辑数据库。 |

`--offline` 只表示操作者已经完成停服，不会自动停止进程。恢复和清理命令可能因处理安全窗口或旧租约未结束而保留待处理项，需要等待后再次执行。

目前 `purge:knowledge` 仍引用缺失的历史脚本，暂不可用。更多命令和维护说明见 [常用命令速查](./常用命令速查.md)。

## 部署说明

应用需要支持 Node.js 的服务运行环境。配置生产环境变量、完成数据库迁移并通过检查后，构建并启动：

```bash
npm run build
npm run start
```

- 将 `BETTER_AUTH_URL` 和 `NEXT_PUBLIC_APP_URL` 配置为实际访问地址，并在构建前确定客户端使用的地址。
- Web 服务需能访问 PostgreSQL、Elasticsearch、OSS 及启用功能所依赖的模型、解析和搜索接口。
- 反向代理需支持 SSE 持续输出，避免缓存流式响应；上传与重解析可能持续数分钟，代理和运行平台的请求时限需覆盖处理预算。
- 默认解析超时为 8 分钟，完整文档处理预算为 10 分钟；调整 `MINERU_TIMEOUT_MS` 时需同步核实部署时限。
- 使用进程托管保持 Web 服务运行；无须另外启动文档 Worker。进程异常中断后，按停服流程运行一次性恢复命令。

### 当前已知限制

- 尚未接入运行链路的 `save-finding.ts`、`search-papers.ts`、`verify-source.ts` 存在缺失依赖或导入，当前会阻塞全量 TypeScript 检查和生产构建；文献专用检索、核验和保存工具不列为已实现功能。
- 全量 ESLint 仍包含生成的 Prisma 代码及部分组件的历史问题，需与当前修改范围的检查结果区分。
- 现有知识库自动化测试模拟了外部服务；上线前仍需验证真实登录、上传、MinerU 解析、向量化、检索及删除清理流程。

## 目录结构

```text
app/
├── (routes)/                 # 项目介绍、认证、对话、知识库与设置页面
└── api/                      # Hono 业务接口与认证入口
components/                   # 聊天、知识库及公共界面组件
context/                      # 查询、主题与界面上下文
hooks/                        # 会话、认证、知识库等 Hooks
stores/                       # 共享界面状态
lib/
├── agent/                    # 联网 Agent、研究规划、执行、评估与报告
├── ai/                       # 模型配置及 AI 工具
├── chat/                     # 消息持久化、附件与引用处理
├── knowledge/                # 文档解析、分块、索引、检索和资源清理
├── es/                       # Elasticsearch 索引与检索
└── storage/                  # OSS 存储操作
prisma/                       # 数据模型与数据库迁移
tests/                        # Vitest 回归测试
workers/                      # 一次性恢复、重建索引与资源清理命令
```

开发与修改约定见 [AGENTS.md](./AGENTS.md)。
