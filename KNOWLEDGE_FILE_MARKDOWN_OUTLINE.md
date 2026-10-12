# 知识库四类文件 Markdown 化实施大纲

> 更新日期：2026-10-12。以当前仓库代码为准，遵循根目录 AGENTS.md。
> “代码已实现”不等于真实服务已验收，数据库、OSS、MinerU 联调需单独验证。

## 1. 目标与当前进度

支持 PDF、DOCX、TXT、Markdown 四种文件，扩展名为 .pdf、.docx、.txt、.md/.markdown。XLSX 已移出范围。

除 Markdown 外，其余三种文件转换为 Markdown。PDF/DOCX 使用 MinerU；TXT 使用本地解析器；Markdown 进行编码和基础清理。

| 阶段 | 当前状态 | 尚需完成 |
| --- | --- | --- |
| P0：模型与契约 | 模型、解析类型和迁移文件已存在 | 核实目标数据库迁移状态和存量数据 |
| P1：上传与解析 | 上传、OSS、Worker、四类解析器和读取接口已实现 | 四类真实文件与第三方服务联调 |
| P2：Markdown 工作台 | 尚未实现 | 文件树、阅读、编辑、保存及文档操作 |
| P3：分块与检索准备 | 已有 DocumentChunk 模型，尚无分块实现 | 按当前正文版本生成和更新 Chunk |
| P4：性能增强 | 尚未实施 | 有实际性能问题后再优化 |

当前“知识库”侧栏入口指向 /home，该页仍是笔记占位内容。下一步是 P2-a：知识库列表、文件树、上传、解析状态和只读预览。

## 2. 现有处理流程

```text
上传 PDF / DOCX / TXT / MD
  -> 文件大小、扩展名、MIME 和必要签名检查
  -> 确认知识库与文件夹归属
  -> 原文件写入 OSS
  -> 同一事务创建文档（QUEUED）和解析任务（PENDING）
  -> 独立 Worker 领取任务，文档进入 PARSING
  -> 下载原文件，检查大小和 SHA-256
  -> PDF/DOCX：MinerU -> Markdown 与图片
     TXT：解码 -> Markdown
     MD：解码与基础清理
  -> 图片转存 OSS，正文引用站内鉴权地址
  -> 同一事务保存正文、元数据和任务成功状态
  -> 文档 READY
```

失败按错误是否可重试及任务次数，回到 QUEUED 或进入 FAILED。Web 服务和文档 Worker 分别运行；仅启动 Web 不会消费解析任务。

## 3. 正文、存储与安全边界

- markdownContent 是阅读、编辑和后续分块的唯一正文来源。
- plainText 从 Markdown 派生，不作为另一份独立可编辑的正文。
- 原文件独立保存在 OSS，编辑 Markdown 不修改原文件。
- 图片使用 /api/knowledge-documents/:id/assets/:assetName，读取时校验登录态和所有权，不公开 storageKey。
- 现有知识库/目录删除采用软删除，同时取消解析任务，登记原文件和已有图片的 CLEANUP 任务。
- 源文件上限为 20 MB，Markdown 上限为 2,000,000 个字符。
- 上传前后的归属检查保护不同阶段；目录锁、任务租约、事务和失败补偿保留。
- Markdown 渲染安全属于 P2 待实现内容，文件校验不能代替 HTML、链接和图片的预览限制。

## 4. 四类文件解析实现

统一类型位于 lib/knowledge/parsers/types.ts，以源码为准：

```ts
type KnowledgeSourceKind = "pdf" | "docx" | "txt" | "markdown"

interface ParseLocator {
  page?: number
  headingPath?: string[]
  paragraph?: number
}

interface ParsedMarkdownDocument {
  markdown: string
  plainText: string
  metadata: Record<string, unknown>
  sections: Array<{
    startOffset: number
    endOffset: number
    locator: ParseLocator
  }>
  warnings: string[]
}
```

page 是类型允许的字段，当前解析器尚未生成 PDF 页码定位；没有 Sheet 或行号字段。

### 4.1 PDF / DOCX：MinerU

registry.ts 直接注册 createMineruParser("pdf") 和 createMineruParser("docx")，共用转换流程：

1. 上传入口检查 PDF 标识，或 DOCX 的 ZIP 标识与 Word 主文档路径。
2. Worker 从本站 OSS 下载原文件后提交 MinerU。
3. 客户端申请上传地址、PUT 文件、轮询任务，再下载结果 ZIP。
4. 读取 ZIP 中的 full.md，收集 Markdown 中的相对图片引用。
5. JPEG、PNG、WebP 图片转存本站 OSS，替换成站内鉴权 URL。
6. 清理正文、检查输出大小、派生纯文本和标题章节。
7. 保存 provider、batchId、modelVersion、文件名、sections、warnings 和 assetNames 等元数据。

MINERU_API_TOKEN 必须配置；API 地址、模型、语言、轮询间隔和超时沿用现有客户端配置。

当前限制：

- 缺失或不支持的图片跳过；受支持图片上传失败会让解析任务失败，按任务策略处理。
- warnings 当前返回空数组，尚无逐张图片上传失败后继续生成的降级实现。
- PDF/DOCX 当前按 Markdown 标题定位，不保证逐页定位或高保真版式。
- 扫描件、加密文件的结果取决于 MinerU 实际响应，本地没有独立 OCR 或加密错误分类。
- 远端解析结果不承诺字节级一致；站内图片地址还包含任务标识。

知识库采用 MinerU，聊天附件继续使用其现有独立解析流程。知识库不再采用旧的 pdf-parse 或 Mammoth/Turndown 方案。

### 4.2 TXT：本地转 Markdown

- 识别 UTF-8 BOM、UTF-16LE/BE；普通输入先严格 UTF-8，失败后尝试 GB18030。
- 统一换行，删除非法控制字符，检查可能的乱码并拒绝空正文。
- 使用文件名生成一级标题，保留原有列表，对误触发 Markdown 结构的符号做必要转义。
- 按空行分隔的段落记录字符范围及 paragraph 定位。
- 共用输出大小检查和纯文本派生函数。

没有额外的日志识别或自动代码围栏转换。

### 4.3 Markdown：直通处理

共用文本解码流程，清理 BOM、换行、控制字符和首尾空白，拒绝空正文并检查大小。保留 Markdown 结构，提取标题路径及章节范围。

## 5. 数据模型与版本约定

KnowledgeDocument 已有原件字段、markdownContent、plainText、revision、contentRevision、parserVersion、parseMetadata、解析错误、parsedAt、chunkStatus 和 chunkedContentRevision。

20261011130000_add_knowledge_markdown_p1 迁移提供 markdownContent 字段。迁移文件存在不代表目标数据库已执行。

contentJson 仍保留，现有新文档流程不读取或写入它。若确认有需要保留的旧数据，再制定一次性转换方案；目前没有旧正文兼容读取实现。

```text
现有：
QUEUED -> PARSING -> READY
                 -> QUEUED（等待重试）
                 -> FAILED（不可重试或次数耗尽）

P2 待实现：
READY + 保存编辑 -> revision / contentRevision 增加 -> chunkStatus=PENDING
重新解析原件 -> 新解析任务 -> 新正文版本

P3 待实现：
当前正文版本 -> Chunk -> chunkedContentRevision 与 contentRevision 一致
```

解析状态与分块状态独立。READY 只表示正文可读，不代表已经分块或索引。

## 6. 当前后端文件

```text
lib/knowledge/
  service.ts                       # 知识库、目录、树与删除事务
  ownership.ts                     # 所有权、目录归属和结构锁
  schemas.ts                       # 请求参数
  errors.ts                        # 业务错误与 HTTP 响应
  document-service.ts              # 上传、详情和资源读取
  assets.ts                        # 图片路径、类型与元数据
  parsers/
    types.ts
    registry.ts
    normalize.ts                   # 解码、清理、纯文本与章节
    mineru-client.ts               # MinerU 上传、轮询、结果下载
    mineru-to-markdown.ts           # PDF/DOCX 共用转换
    txt-to-markdown.ts
    markdown-pass-through.ts
  jobs/processor.ts                # 租约、解析、清理与有限重试

lib/storage/oss.ts                  # 现有共享 OSS 能力
workers/document-worker.ts
app/api/[[...route]]/knowledge-base.ts
app/api/[[...route]]/knowledge-folder.ts
app/api/[[...route]]/knowledge-document.ts
```

后续在现有服务和路由中增加业务。需要分块时再增加实际实现，不预先建立 Storage、Pipeline、Enqueue 等透传层。

## 7. API：已有与待实现

### 7.1 已有接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET / POST | /api/knowledge-bases | 知识库列表、创建 |
| PATCH / DELETE | /api/knowledge-bases/:id | 修改、软删除知识库 |
| GET | /api/knowledge-bases/:id/tree | 文件树摘要 |
| POST | /api/knowledge-bases/:id/folders | 创建文件夹 |
| PATCH / DELETE | /api/knowledge-folders/:id | 修改、移动、删除文件夹 |
| POST | /api/knowledge-bases/:id/documents | multipart 上传，返回 202 |
| GET | /api/knowledge-documents/:id | 元数据、Markdown、状态及版本 |
| GET | /api/knowledge-documents/:id/assets/:assetName | 站内鉴权图片 |

### 7.2 待实现接口

| 阶段 | 方法 | 路径 | 作用 |
| --- | --- | --- | --- |
| P2-b | PATCH | /api/knowledge-documents/:id/content | 保存正文及 expectedContentRevision |
| P2-c | POST | /api/knowledge-documents/:id/reparse | 从原件重新解析 |
| P2-c | GET | /api/knowledge-documents/:id/original | 授权下载原件 |
| P2-c | DELETE | /api/knowledge-documents/:id | 单文档软删除及清理 |
| P3 | POST | /api/knowledge-documents/:id/reindex | 触发当前正文分块，索引按实际阶段接入 |

P2-a 复用文档详情接口轮询状态；有实际响应体开销问题后再考虑轻量状态接口。上传继续使用现有 multipart 方式。

P2-b 保存约定：

- 请求携带 markdownContent 和 expectedContentRevision。
- 原子校验所有权、文档状态及版本；版本不匹配返回 409 CONTENT_REVISION_CONFLICT。
- 更新正文、派生纯文本和当前正文定位，增加 revision/contentRevision，并标记分块待处理。
- 解析进行中暂不开放编辑保存；重解析前提示会替换正文，并在提交结果时保护版本一致性。
- 冲突保留本地草稿，提供重新加载和复制本地内容。

## 8. P2 页面与编辑器方案

首批新增文件均为规划，尚未存在：

```text
app/(routes)/(dashboard)/knowledge/page.tsx
components/knowledge/
  knowledge-shell.tsx              # 知识库选择、文件树与内容
  knowledge-tree.tsx
  document-upload.tsx
  markdown-preview.tsx
hooks/use-knowledge.ts              # API 查询、上传与状态轮询
```

先用一个页面承载知识库与文档选择，需要深层导航时再加详情路由。按 P2-b/P2-c 增加编辑和文档操作，不提前拆出透传组件或 Hook。

- 编辑使用 React 受控的原生 textarea。
- 预览优先复用已安装的 Streamdown，验证静态文档的表格、代码、公式和图片表现。
- 阅读、编辑、对照三种模式共用一份草稿。
- 远端数据沿用 TanStack Query，草稿和模式使用局部 React state。
- 先做手动及快捷键保存，再加自动保存、离开提醒和保存失败后的手动重试。
- 自动保存需避免并发提交旧版本、覆盖新草稿或在冲突后继续重试。

验证不可信 HTML 不执行脚本，拒绝危险链接，隔离打开外链，图片只加载允许的站内资源。外部图片默认不加载；本站图片继续走所有权校验。

## 9. P3 分块与定位计划

仅读取已保存的 markdownContent，优先按标题、完整表格/代码/列表/引用块和普通段落拆分；超长单块按明确的大小限制切分。

Chunk 保存 documentId、contentRevision、chunkIndex、正文、checksum 和定位元数据。生成及提交时核对正文版本，旧版本块不得进入检索。

PDF/DOCX 当前按标题和字符范围定位。回到 PDF 原页需要后续获取、验证并保存 MinerU 页码信息，不能由标题定位推断。页码增强不作为基础分块交付前提。

Embedding、向量存储和 RAG 回答在工作台与分块闭环完成后另行确定。

## 10. 错误与用户提示

| 错误码 | 当前用途 |
| --- | --- |
| UNSUPPORTED_FILE_TYPE | 不支持的格式或不具备解析源信息 |
| FILE_SIGNATURE_MISMATCH | MIME/签名不符，或原件完整性失败 |
| FILE_TOO_LARGE | 源文件超过上限 |
| UNSUPPORTED_TEXT_ENCODING | 无法可靠识别文本编码 |
| PARSE_TIMEOUT | MinerU 等待或 Worker 超时 |
| PARSE_FAILED | 空正文、第三方失败或其他解析错误 |
| OUTPUT_TOO_LARGE | Markdown 超过上限 |
| CONTENT_REVISION_CONFLICT | P2-b 待新增的保存冲突 |

知识库不存在、目录循环、非空删除等错误沿用 errors.ts。HTTP 上传校验也可能直接返回 Hono 响应，前端应处理实际契约。

旧的 PDF_ENCRYPTED/OCR_REQUIRED 已移除。失败信息不得暴露堆栈、OSS Key 或服务器路径。

## 11. 测试与验收

### 已有自动化覆盖

- tests/knowledge-parsers.test.ts：Markdown 标题、TXT 解码和段落定位、签名/MIME、MinerU PDF/DOCX、图片转存和任务创建失败。
- tests/knowledge-flow.test.ts：错误契约、上传补偿、任务成功/重试/失败、租约失效时的失败处理、清理任务及目录删除。

测试使用模拟数据库、OSS 和 MinerU，不证明真实事务、真实服务或扫描件解析已验收。

### P1 / P2-a 真实联调

- 核实数据库迁移状态，分别启动 Web 和 npm run worker:documents。
- 各上传一份真实 PDF、DOCX、TXT、MD，确认最终 READY 或显示明确失败。
- PDF/DOCX 检查中文、表格和图片；TXT/MD 检查编码和正文。
- 刷新后结果一致，FAILED 后停止等待并展示原因。
- 不同用户不能越权读取知识库、文档和图片。
- 删除后验证 CLEANUP 消费和 OSS 对象实际回收。

### P2-b / P2-c / P3 待验收

- 保存、刷新、双标签页冲突、草稿保留和自动保存顺序。
- 恶意 Markdown、危险链接和外部图片的渲染安全。
- 原件下载、单文档删除及确认后的重新解析。
- Chunk 与当前 contentRevision 一致，旧版本不可召回。

## 12. 分阶段实施

### P0 / P1：代码已具备，完成真实验收

复用现有模型、解析器、Worker 和 API，通过真实文件确认 OSS、MinerU、数据库完整连通。

### P2-a：上传与只读阅读——下一批工作

1. 知识库导航接到实际页面。
2. 知识库列表、创建与选择。
3. 文件树和必要的目录创建。
4. 四类文件上传、刷新树并选中文档。
5. QUEUED/PARSING 时轮询，READY 预览，FAILED 展示错误。
6. 完成真实文件和预览安全验收。

验收：用户能上传、看状态和阅读，刷新后结果一致。

### P2-b：编辑与保存

保存接口、乐观锁、阅读/编辑/对照模式、手动及快捷键保存，再补自动保存和离开提醒。

验收：编辑保存后刷新一致，冲突不会静默覆盖内容。

### P2-c：文档操作

授权下载、单文档软删除和重新解析，复用现有所有权、任务和清理逻辑。

验收：下载受保护，删除回收资源，重解析有替换提示并产生新正文版本。

### P3：当前版本分块

Markdown 结构分块、编辑后重建、版本检查和真实可提供的定位信息。

验收：块可追溯到当前版本及标题/段落/字符范围；PDF 页码另行增强。

### P4：按实际问题优化

测量长文档性能。有需要时复用 @tanstack/react-virtual；编辑器升级、专用状态接口和监控围绕已确认的问题实施。

## 13. 范围边界

- 支持 PDF、DOCX、TXT、MD，不包含 XLSX。
- 扫描件识别交给 MinerU，不另外建立本地 OCR 或第二套解析流程。
- Markdown 编辑不反向修改原件，不承诺 PDF 高保真还原。
- 多人协同、完整版本历史和文件反向导出暂不纳入 P2。
- RAG、向量存储和多 Agent 不属于当前工作台交付范围。
