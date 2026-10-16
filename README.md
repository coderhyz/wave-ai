# Wave AI

AI 对话与个人知识库应用，支持多模型聊天、文档问答、联网搜索和深度研究。

## 技术栈

- **框架**：Next.js 16（App Router + Turbopack）、React 19
- **语言**：TypeScript
- **接口**：Hono、Hono RPC、Zod
- **数据库**：PostgreSQL、Prisma ORM、pgvector
- **认证**：Better Auth（邮箱密码登录）
- **状态管理**：Zustand、TanStack Query
- **UI**：Tailwind CSS 4、shadcn/ui、Radix UI
- **AI**：AI SDK 7、DeepSeek、通义千问
- **检索**：Elasticsearch、向量召回、RRF 融合、可选模型重排
- **文档与存储**：MinerU、阿里云 OSS

## 功能

### 对话

- SSE 流式回答，支持停止生成和重新生成
- DeepSeek、通义千问模型切换及思考过程展示
- 图片和文档附件问答
- 会话管理（创建、删除、重命名、置顶）
- 消息复制、Markdown 导出、保存到知识库

### 知识库

- 上传 PDF、DOCX、TXT、Markdown，单文件最大 20 MB
- 文档解析、预览、下载、重命名及重新解析
- 文本分块、向量化与关键词混合检索
- 当前文档问答与跨知识库检索
- 引用文档卡片、来源侧栏及文档跳转

### 联网与深度研究

- Tavily 网页搜索与正文读取
- 快速、标准、深入三种研究深度
- 支持网页、知识库或混合来源
- 研究规划、检索阅读、覆盖评估和报告生成
- 引用溯源与研究状态展示

### 其他

- 邮箱密码注册与登录，按用户隔离数据
- 浅色、深色及跟随系统主题
- 响应式布局

## 开发

需要 Node.js 22+、npm，以及可访问的 PostgreSQL、Elasticsearch 和阿里云 OSS。PostgreSQL 需支持 `vector`、`pg_trgm` 扩展；数据库和 ES 可以使用现成的远程服务。

### 安装

```bash
npm ci
```

### 配置

在项目根目录创建 `.env`，替换以下示例地址和凭证：

```dotenv
# 数据库与认证
DATABASE_URL="postgresql://user:password@your-pg-host:5432/wave_ai?sslmode=require"
BETTER_AUTH_SECRET="replace-with-a-random-secret-of-at-least-32-characters"
BETTER_AUTH_URL="http://localhost:3000"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# 模型：DeepSeek 用于聊天、标题和上下文压缩；千问同时用于文档向量化
DEEPSEEK_API_KEY="your-deepseek-api-key"
QWEN_API_KEY="your-qwen-api-key"

# Elasticsearch
ELASTICSEARCH_URL="https://your-es-host:9200"
ELASTICSEARCH_USERNAME="your-es-username"
ELASTICSEARCH_PASSWORD="your-es-password"
ELASTICSEARCH_REQUEST_TIMEOUT_MS=30000

# 阿里云 OSS
OSS_REGION="oss-cn-hangzhou"
OSS_BUCKET="your-bucket"
OSS_ACCESS_KEY_ID="your-access-key-id"
OSS_ACCESS_KEY_SECRET="your-access-key-secret"

# PDF / DOCX 解析与联网搜索
MINERU_API_TOKEN="your-mineru-token"
TAVILY_API_KEY="your-tavily-api-key"

# 可选重排：先关闭，启用时配置百炼 RAG_RERANK_URL
RAG_RERANK_ENABLED=false
```

API Key 通过服务端环境变量配置，不要提交真实凭证。部署时将两个应用地址改为实际域名，修改环境变量后重新部署。

### 数据库

确认 `DATABASE_URL` 指向目标数据库后，应用已有迁移并生成客户端：

```bash
npx prisma migrate deploy
npx prisma generate
```

### 运行

```bash
# 开发模式，访问 http://localhost:3000
npm run dev

# 生产构建与启动
npm run build
npm run start
```

文档上传和重新解析在当前请求内完成，无须常驻 Worker。默认解析时限为 8 分钟、完整处理预算为 10 分钟，部署平台及反向代理需提供相应的请求时长，并支持 SSE。

## 脚本

```bash
# 类型与代码检查
npm run typecheck
npm run lint

# 数据库管理
npm run db:studio

# 一次性重建文档索引
npm run reindex:documents

# 一次性清理已登记的 OSS / ES 资源
npm run cleanup:documents

# 先停止所有连接同一数据库的 Web/API 实例及旧 Worker，再恢复中断状态
npm run recover:documents -- --offline
```

索引重建会调用向量服务并写入索引；资源清理会删除已登记的对象；恢复命令只修正中断状态，不会自动重新解析。更多说明见 [常用命令速查](./常用命令速查.md)。

## 项目结构

```text
app/
├── (routes)/       # 介绍页、认证、对话、知识库及设置
└── api/            # Hono API 与认证接口
components/         # 聊天、知识库及公共 UI 组件
hooks/              # 数据请求与交互 Hooks
stores/             # Zustand 状态管理
context/            # 主题与查询上下文
lib/
├── ai/             # 模型、提示词与工具
├── agent/          # 联网及深度研究流程
├── chat/           # 消息存储与引用处理
├── knowledge/      # 文档解析、分块、向量化与检索
├── es/             # Elasticsearch 客户端与索引
└── storage/        # OSS 文件存储
prisma/             # 数据模型与迁移
workers/            # 一次性恢复、索引重建与资源清理
```


