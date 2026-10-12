# 知识库四类文件 Markdown 化实施大纲

## 1. 目标与统一流程

知识库统一支持 `.pdf`、`.docx`、`.txt`、`.md/.markdown` 四种文件。

除 Markdown 外，其余四种文件必须先经过服务端解析器转换为 Markdown。转换后的 Markdown 是知识库中的“可编辑正文”，统一进入阅读、编辑、分块和后续检索流程；原文件独立保留，仅用于下载、重新解析和溯源。

```text
文件上传
  -> 类型与安全校验
  -> 原文件写入 OSS
  -> 创建 KnowledgeDocument（QUEUED）
  -> Worker 选择解析器
  -> 生成 Markdown + 定位元数据
  -> 保存 markdownContent（READY）
  -> Markdown 编辑器阅读 / 编辑 / 预览
  -> 按 Markdown 结构分块
  -> 后续 Embedding / 检索
```

## 2. 参考仓库结论

`gdut4140/summer-checkin` 没有使用 Monaco、CodeMirror、Milkdown 或 Vditor 等成品编辑器。它的文档工作台是自定义组合：

- 编辑区：React 受控的原生 `<textarea>`；
- 预览区：`react-markdown`；
- 扩展：`remark-gfm`、`remark-math`、脚注、定义列表；
- 安全和增强：`rehype-sanitize`、`rehype-highlight`、`rehype-katex`；
- 长文档：按安全边界切块后用 `react-virtuoso` 虚拟渲染；
- 交互：阅读、编辑、左右对照三种模式，另有目录、搜索和滚动同步。

它当前的知识库流程不能直接满足本需求：PDF/DOCX 只提取成纯文本，并且知识库阅读页只允许 Markdown 类型进入。Wave AI 应借用“统一 Markdown 正文 + 分栏工作台”的思路，但按当前仓库重新实现四类文件解析流程。

## 3. 核心设计决策

### 3.1 Markdown 是唯一正文格式

- `markdownContent` 是展示、编辑、分块和索引的唯一正文来源。
- `plainText` 由 `markdownContent` 派生，只用于全文搜索、长度统计或模型输入降级。
- 不再把 Tiptap JSON 作为知识库文档正文的主格式。
- 用户修改 Markdown 只更新解析副本，不反向修改 PDF、DOCX 或 TXT 原件。
- “恢复解析版本”从原文件重新生成 Markdown，并创建新的正文版本。

### 3.2 原文件和解析副本分离

```text
OSS 原文件：storageKey
        |
        +-> Parser -> markdownContent -> Chunk -> Index
                              |
                              +-> Markdown 编辑器
```

原文件提供可审计来源；Markdown 副本提供统一体验。删除文档时二者通过清理任务统一回收。

### 3.3 编辑器采用参考仓库的轻量方案

MVP 使用原生 `<textarea>` + `react-markdown`，实现阅读、编辑、对照三种模式，支持 GFM 表格、快捷键保存、1 秒防抖自动保存、离开页面提醒和保存失败重试。保存接口基于 `contentRevision` 做乐观锁，避免多标签页静默覆盖。

首版不引入 Monaco 或富文本编辑器。只有在需要语法高亮、折叠、补全或超长文本增量编辑时，再把 `<textarea>` 替换为 CodeMirror 6；数据和 API 无需改变。

### 3.4 预览安全边界

- 使用 `react-markdown` + `remark-gfm`；
- 默认不启用原始 HTML；
- 外链限制危险 URL scheme，并设置 `noopener noreferrer`；
- 图片首版只允许受控 OSS 地址，外部图片默认不加载；

## 4. 四类文件解析契约

所有解析器实现同一接口：

```ts
type KnowledgeSourceType = "pdf" | "docx" | "txt" | "markdown"

interface ParseLocator {
  page?: number
  sheet?: string
  rowStart?: number
  rowEnd?: number
  headingPath?: string[]
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

interface KnowledgeDocumentParser {
  kind: KnowledgeSourceType
  version: string
  parse(input: Buffer, context: ParseContext): Promise<ParsedMarkdownDocument>
}
```

### 4.1 PDF -> Markdown

复用仓库已有的 `pdf-parse`，但不能只返回拼接后的纯文本：

- 按页提取并保留页码；每页增加稳定的 source/page 定位信息；
- 默认用 `## 第 N 页` 分隔页面；
- 合并被硬换行拆开的普通段落，保留明显列表；
- 对象存储回调存在时按页提取图片，过滤宽或高小于 50px 的小图；
- 只接受 JPEG、PNG、WebP，单张上传失败时记录 warning 并继续；
- 正文尚无 GFM 表格时调用 `getTable()`，按页追加 `### 表格 N`；
- 表格提取失败时保留页面文本，不让整份 PDF 失败；
- `sections.locator.page` 保存页号，后续 Chunk 和引用可回到原页。

加密 PDF 直接失败；扫描件无文本层时返回 `OCR_REQUIRED`。图片和表格属于尽力提取，不承诺公式、复杂多栏排版和表格的高保真还原。知识库的文件大小、页数和超时上限独立于聊天附件。

### 4.2 TXT -> Markdown

新增 `TextMarkdownParser`，不能把任意字节直接当 UTF-8：

- 识别 UTF-8 BOM、UTF-16LE/BE，中文文本可增加 GB18030 兜底；
- 统一换行，去除 NUL 与非法控制字符；
- 保留段落、列表和有意义的空行；
- 对意外触发 Markdown 的普通文本符号做最小必要转义；
- 纯日志可按明确规则放入 fenced code block；
- 无法可靠识别编码时返回 `UNSUPPORTED_TEXT_ENCODING`。

### 4.3 Markdown -> Markdown

Markdown 不进行语义转换，只校验大小和 UTF 编码、统一换行、清除非法控制字符，并提取标题路径和块级 locator。正文原文保留；预览层默认不执行原始 HTML。

### 4.4 DOCX -> Markdown

采用线性转换管道，不直接使用 Mammoth 已废弃的 Markdown 输出：

1. 校验 DOCX ZIP 结构和解压后大小；
2. `mammoth.convertToHtml` 将 Word 标题、段落、列表和表格转换为结构化 HTML；
3. `turndown` + `turndown-plugin-gfm` 将 HTML 转换为 Markdown；
4. Word 表格首行提升为表头，输出 GFM 表格；
5. 文档图片通过可选资源上传器写入 OSS，Markdown 只保存站内授权 URL；
6. 清理多余空行并提取标题 locator。

Mammoth 的转换消息写入 warnings；单张图片上传失败时仅跳过该图片，正文继续生成。

## 5. 数据模型调整

当前 `KnowledgeDocumentType` 已包含 `PDF / DOCX / MARKDOWN / TEXT`，四类文件共用 Markdown 正文。

```prisma
enum KnowledgeDocumentType {
  PDF
  DOCX
  MARKDOWN
  TEXT
}

model KnowledgeDocument {
  // 现有标识、所属关系和源文件字段保留
  markdownContent        String?
  plainText              String                 @default("")
  revision               Int                    @default(0)
  contentRevision        Int                    @default(0)
  parserVersion          String?
  parseMetadata          Json?
  parseErrorCode         String?
  parseErrorMessage      String?
  parsedAt               DateTime?
  chunkedContentRevision Int?
}
```

迁移策略：

1. 新增 `markdownContent` 字段；
2. 若已有 `contentJson` 数据，先提供兼容读取或一次性转换；
3. 新代码只写 `markdownContent`；
4. 观察一个版本后再删除 `contentJson`；
5. `DocumentChunk.metadata` 写入 page、heading path 等 locator。

```text
QUEUED -> PARSING -> READY
                   -> FAILED

READY + 用户编辑 -> contentRevision + 1 -> chunkStatus=PENDING
重新解析原件      -> PARSING -> 新 contentRevision -> READY
```

解析成功和分块成功必须是两个独立状态。分块失败时用户仍然可以阅读、编辑和保存 Markdown。

## 6. 后端模块大纲

```text
lib/knowledge/
  document-service.ts             # 创建、详情、更新、软删除、版本检查
  document-storage.ts             # OSS 上传、下载和清理
  markdown/
    normalize.ts                  # 换行、控制字符、GFM 转义
    to-plain-text.ts              # Markdown 派生纯文本
  parsers/
    types.ts                      # 统一接口与错误码
    registry.ts                   # MIME + 扩展名 + 文件头选择解析器
    pdf-to-markdown.ts
    txt-to-markdown.ts
    markdown-pass-through.ts
  pipeline/
    parse-document.ts             # 调用 parser、保存正文与元数据
    chunk-markdown.ts             # 按标题、表格、页/Sheet 边界切块
    enqueue.ts                    # 幂等创建处理任务
  jobs/processor.ts               # 租约、重试、失败归类

workers/document-worker.ts
app/api/[[...route]]/knowledge-document.ts
```

解析器选择不能只信任扩展名或浏览器 MIME。至少同时检查扩展名、MIME 和文件头；冲突时拒绝上传并返回可读错误。

## 7. API 大纲

| 方法     | 路径                                    | 作用                                     |
| -------- | --------------------------------------- | ---------------------------------------- |
| `POST`   | `/api/knowledge-bases/:id/documents`    | P1 multipart 上传、写 OSS 并创建解析任务 |
| `GET`    | `/api/knowledge-documents/:id`          | 返回元数据、Markdown、状态和 revision    |
| `PATCH`  | `/api/knowledge-documents/:id/content`  | 保存 Markdown 和 expectedContentRevision |
| `GET`    | `/api/knowledge-documents/:id/status`   | 查询解析、分块和索引状态                 |
| `POST`   | `/api/knowledge-documents/:id/reparse`  | 从原文件重新生成 Markdown                |
| `POST`   | `/api/knowledge-documents/:id/reindex`  | 对当前正文重新分块/索引                  |
| `GET`    | `/api/knowledge-documents/:id/original` | 授权后下载原件                           |
| `DELETE` | `/api/knowledge-documents/:id`          | 软删除并登记清理任务                     |

P1 先采用 20 MB 上限的服务端 multipart 上传，接口会同时校验请求大小、文件大小、扩展名、MIME 和文件签名，支持 PDF、DOCX、TXT 和 Markdown。若后续需要支持更大的原文件，再扩展为 `upload/init` + `upload/complete` 的 OSS 预签名直传流程。

保存时必须携带 `expectedContentRevision`。若服务端版本不同，返回 `409 CONTENT_REVISION_CONFLICT`，前端提供“重新加载”和“复制本地内容”，不能直接覆盖。

## 8. 前端页面与组件大纲

```text
app/(routes)/(dashboard)/knowledge/
  page.tsx
  [knowledgeBaseId]/
    page.tsx
    documents/[documentId]/page.tsx

components/knowledge/
  knowledge-shell.tsx              # 文件树 + 主内容区
  knowledge-tree.tsx
  document-upload.tsx              # 接受 pdf/docx/txt/md/markdown
  document-status.tsx              # 排队、解析、失败、重试
  markdown-studio.tsx              # 阅读/编辑/对照与保存状态
  markdown-editor-pane.tsx         # 原生 textarea
  markdown-preview.tsx             # react-markdown + GFM
  document-toolbar.tsx             # 保存、重解析、下载、删除
  revision-conflict-dialog.tsx

hooks/
  use-knowledge-documents.ts
  use-document-autosave.ts
  use-document-status.ts
```

```text
+----------------------+-------------------------------------------+
| 知识库 / 文件树       | 标题  状态  [阅读] [编辑] [对照] [保存]   |
|                      +---------------------+---------------------+
| - 文件夹             | Markdown 预览       | Markdown 源码       |
|   - 文档.pdf          |                     | textarea            |
|   - 说明.txt          |                     |                     |
|   - README.md         |                     |                     |
+----------------------+---------------------+---------------------+
```

解析中的文档显示状态页，不渲染空编辑器；解析失败显示错误原因、重新解析和删除入口。

## 9. Markdown 分块规则

分块只读取已保存的 `markdownContent`，不能再次读取原文件形成第二套正文。边界优先级：

1. PDF 页锚点；
2. Markdown 标题；
3. 完整表格、代码块、列表、引用块；
4. 普通段落；
5. 只有超长单块才按字符或 token 兜底切分。

每个 Chunk 保存 `documentId`、`contentRevision`、`chunkIndex`、正文、`checksum` 和 `metadata.locator`。编辑后只允许当前正文版本的 Chunk 进入检索。

## 10. 错误码与用户提示

| 错误码                      | 场景                  | 用户提示                                |
| --------------------------- | --------------------- | --------------------------------------- |
| `UNSUPPORTED_FILE_TYPE`     | 非四类文件            | 仅支持 PDF、DOCX、TXT 和 Markdown |
| `FILE_SIGNATURE_MISMATCH`   | 扩展名与内容冲突      | 文件格式与扩展名不一致                  |
| `FILE_TOO_LARGE`            | 原文件超限            | 请拆分文件后重新上传                    |
| `PDF_ENCRYPTED`             | PDF 加密              | 请移除密码后上传                        |
| `OCR_REQUIRED`              | 扫描 PDF 无文本层     | 该 PDF 需要先进行 OCR                   |
| `UNSUPPORTED_TEXT_ENCODING` | TXT 编码无法识别      | 请另存为 UTF-8 后上传                   |
| `PARSE_TIMEOUT`             | Worker 超时           | 可重试或拆分文件                        |
| `CONTENT_REVISION_CONFLICT` | 并发保存冲突          | 文档已在其他位置更新                    |

失败状态不得把解析器堆栈、OSS Key 或服务器路径返回给浏览器。

## 11. 测试与验收

### 11.1 解析器

- PDF：多页、空页、加密、扫描件、中文、硬换行、多栏退化；
- TXT：UTF-8、BOM、UTF-16、GB18030、乱码、控制字符；
- MD：标题、GFM 表格、代码围栏、恶意 HTML、危险链接；
- DOCX：标题层级、列表、表格、图片降级、损坏 ZIP；
- 相同输入和 parserVersion 必须生成相同正文与 checksum。

### 11.2 服务与任务

- 用户所有权隔离，OSS 完成回调不能绑定他人的对象；
- 重复 complete/retry 不创建重复任务；
- 任务租约过期可恢复，解析失败不会生成 READY 文档；
- revision 原子递增，旧 revision 保存返回 409；
- 当前正文版本与 Chunk 版本一致。

### 11.3 前端

- 四类文件最终进入同一个 Markdown 工作台；
- TXT 和 MD 不乱码；
- 三种工作台模式、自动保存、失败重试和冲突提示可用；
- 刷新后内容一致，恶意 Markdown 不能执行脚本；
- 原件可下载，但未授权用户无法读取。

## 12. 分阶段实施

### P0：模型与契约

- 新增 `markdownContent`；
- 固定 parser 接口、错误码、状态机和上传限制；
- 确认已有 `contentJson` 数据的兼容策略。

验收：迁移可执行，现有知识库和聊天功能不回归。

### P1：四类解析器

- 实现 Markdown、TXT、PDF、DOCX 解析器；
- 原件写 OSS，Worker 完成解析、状态更新和失败重试；
- 保存 Markdown、plainText、metadata 和 locator。

验收：四个代表性文件都生成可读 Markdown。

### P2：Markdown 工作台

- 新增文件树和文档详情页；
- 实现阅读、编辑、对照、自动保存、乐观锁、重新解析和下载原件；
- 预览启用 GFM 表格并完成安全测试。

验收：四类文档使用同一工作台完成阅读和修改。

### P3：分块与检索准备

- 按 Markdown 结构和 locator 分块；
- 编辑后重建当前版本 Chunk，旧版本不可召回；
- 为后续 Embedding 和引用定位提供稳定元数据。

验收：PDF 可定位到页，MD/TXT 可定位到标题或段落。

### P4：性能增强

- 超长 Markdown 安全分块；
- 使用仓库已有的 `@tanstack/react-virtual` 虚拟化预览；
- 只有真实编辑性能不足时再升级 CodeMirror；
- 增加解析耗时、失败率、文件大小和输出字符数监控。

## 13. 本次明确不做

- OCR 和 PDF 高保真版式复刻；
- 将修改后的 Markdown 反向导出为 PDF/TXT；
- 多人实时协同编辑和版本历史 UI；
- Embedding、RAG 和引用回答本身——本大纲只准备稳定正文与 locator。

## 14. 推荐的第一批代码改动

1. Prisma 新增 `markdownContent`，不直接删除 `contentJson`。
2. 新建 `lib/knowledge/parsers/` 和统一解析接口。
3. 从 `lib/chat/model-attachments.ts` 抽取 PDF 底层能力，但为知识库设置独立限额。
4. 新建文档 Worker 和 `knowledge-document` Hono 路由。
5. 新建 `components/knowledge/markdown-studio.tsx`，先实现 textarea + react-markdown。
6. 完成四类格式的解析、安全与端到端测试后，再接分块和索引。

```text
PDF / DOCX / TXT / MD
  -> Markdown
  -> 可阅读
  -> 可编辑
  -> 可保存
  -> 可重新分块
```
