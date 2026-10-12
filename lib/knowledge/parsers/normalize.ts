import iconv from "iconv-lite"
import {
  KnowledgeParseError,
  type ParsedSection,
} from "@/lib/knowledge/parsers/types"

/**
 * 文本中不允许出现的控制字符。
 * 换行符和制表符仍然保留，避免破坏文档原有排版。
 */
const INVALID_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * 对所有解析器产生的文本做基础清理：
 * 1. 删除开头的 BOM；
 * 2. 将 Windows、旧版 Mac 换行统一成换行符；
 * 3. 删除可能影响 Markdown 渲染的非法控制字符。
 */
export const normalizeText = (value: string) =>
  value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(INVALID_CONTROL_CHARACTERS, "")

/**
 * 判断解码后的文本是否可能已经乱码。
 * 当替换字符或异常控制字符超过全文的 1% 时，认为编码不可信。
 */
const looksCorrupt = (value: string) => {
  if (!value) return false

  const replacements = value.match(/\uFFFD/g)?.length ?? 0
  const suspiciousControls =
    value.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0

  return (replacements + suspiciousControls) / value.length > 0.01
}

/**
 * 将 TXT 或 Markdown 文件的二进制内容解码为字符串。
 * 优先识别 BOM；普通文件先按 UTF-8 解码，失败后再尝试中文常见的 GB18030。
 */
export const decodeTextBuffer = (buffer: Buffer) => {
  let decoded: string

  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    // UTF-8 BOM：跳过前三个 BOM 字节。
    decoded = buffer.subarray(3).toString("utf8")
  } else if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    // UTF-16 小端序。
    decoded = iconv.decode(buffer.subarray(2), "utf16-le")
  } else if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    // UTF-16 大端序。
    decoded = iconv.decode(buffer.subarray(2), "utf16-be")
  } else {
    try {
      // fatal=true 会让非法 UTF-8 抛错，而不是静默生成乱码。
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    } catch {
      decoded = iconv.decode(buffer, "gb18030")
    }
  }

  decoded = normalizeText(decoded)
  if (looksCorrupt(decoded)) {
    throw new KnowledgeParseError(
      "UNSUPPORTED_TEXT_ENCODING",
      "无法识别文本编码，请另存为 UTF-8 后重新上传"
    )
  }

  return decoded
}

/**
 * 将普通 TXT 内容安全转换成 Markdown。
 * 已有列表保持不变；可能被误认为标题、引用或代码块的符号会被转义。
 */
export const plainTextToMarkdown = (value: string) =>
  normalizeText(value)
    .split("\n")
    .map((line) => {
      if (!line.trim()) return ""

      // 保留原文中已经存在的无序列表和有序列表。
      if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) return line.trimEnd()

      return (
        line
          // 防止普通文本中的标题、引用和代码围栏被当成 Markdown 结构。
          .replace(/^(\s*)(#{1,6}|>|\x60{3}|~~~)(\s*)/, "$1\\$2$3")
          // 防止普通文本里的竖线意外组成 Markdown 表格。
          .replace(/\|/g, "\\|")
          .trimEnd()
      )
    })
    .join("\n")
    .trim()

/**
 * 从 Markdown 派生适合全文搜索和模型输入的纯文本。
 * markdownContent 仍是唯一正文；这里仅去掉常见 Markdown 标记。
 */
export const markdownToPlainText = (markdown: string) => {
  let plainText = markdown

  // 去掉不会显示给用户的注释。
  plainText = plainText.replace(/<!--[\s\S]*?-->/g, " ")
  // 保留代码块内容，但去掉代码围栏及语言名称。
  plainText = plainText.replace(/\x60{3}[^\n]*\n([\s\S]*?)\x60{3}/g, "$1")
  // 图片保留替代文本，普通链接保留可读标题。
  plainText = plainText
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  // 去掉标题、引用、列表等行首语法。
  plainText = plainText
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")

  // 清除常见行内样式，并压缩过多空行。
  return plainText
    .replace(/[*_~\x60]/g, "")
    .replace(/\|/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * 使用原文件名生成默认文档标题。
 * 只删除当前知识库允许的扩展名，避免误删文件名中的其他点号。
 */
export const titleFromFilename = (filename: string) =>
  filename.replace(/\.(?:pdf|docx|txt|md|markdown)$/i, "").trim() ||
  "未命名文档"

/**
 * 按 Markdown 标题生成章节范围。
 * 每个章节记录正文中的字符偏移和完整标题路径，供后续分块与定位使用。
 */
export const extractMarkdownSections = (markdown: string): ParsedSection[] => {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)]

  // 没有标题时，将整篇正文视为一个章节。
  if (headings.length === 0) {
    return markdown
      ? [{ startOffset: 0, endOffset: markdown.length, locator: {} }]
      : []
  }

  // stack 按标题等级保存路径，例如：一级标题 / 二级标题 / 三级标题。
  const stack: string[] = []
  return headings.map((heading, index) => {
    const level = heading[1].length
    stack.splice(level - 1)
    stack[level - 1] = heading[2].trim()

    return {
      startOffset: heading.index,
      endOffset: headings[index + 1]?.index ?? markdown.length,
      locator: { headingPath: stack.filter(Boolean) },
    }
  })
}
