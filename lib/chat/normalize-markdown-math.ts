/**
 * 把模型常用但 remark-math 不直接识别的 LaTeX 分隔符转换成标准 Markdown 数学语法：
 * - `\(...\)`  -> `$...$`（行内公式）
 * - `\[...\]`  -> `$$...$$`（块级公式）
 *
 * 围栏代码块和行内代码保持原样，避免修改教程中的 LaTeX/Markdown 示例。
 */

const normalizeMathDelimiters = (segment: string) =>
  segment
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => {
      const content = expression.trim()
      return content ? `\n$$\n${content}\n$$\n` : _match
    })
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, expression: string) => {
      const content = expression.trim()
      return content ? `$${content}$` : _match
    })

interface MathRange {
  start: number
  end: number
}

const BARE_MATH_RELATION =
  /\b[A-Za-z](?:_(?:\{[^}\n]+\}|[A-Za-z0-9]+)|\^(?:\{[^}\n]+\}|[A-Za-z0-9+-]+))*[ \t]*(?:=|∈|≤|≥|≈|≠|<|>)[ \t]*[A-Za-z0-9_^\[\]{}(),.+\-*/\\…∞∈≤≥≈≠ \t]+/g
const BARE_MATH_TOKEN =
  /\b[A-Za-z]+(?:_(?:\{[^}\n]+\}|[A-Za-z0-9]+)|\^(?:\{[^}\n]+\}|[A-Za-z0-9+-]+))+/g
const BARE_MATH_ARITHMETIC = /\b[A-Za-z](?:[ \t]*[/+*-][ \t]*[A-Za-z0-9])+\b/g
const CJK_SINGLE_VARIABLE =
  /(^|[\u3400-\u9fff][ \t]+)([A-Za-z])(?=[ \t]*(?:的|个|段|中|为|能|可|表示|代表|整除|、|，|。|；|）))/g

const hasBalancedBraces = (value: string) => {
  let depth = 0

  for (const character of value) {
    if (character === "{") depth += 1
    if (character === "}") depth -= 1
    if (depth < 0) return false
  }

  return depth === 0
}

const collectBareMathRanges = (text: string) => {
  const ranges: MathRange[] = []

  const collectMatches = (pattern: RegExp) => {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      const leadingWhitespace = raw.length - raw.trimStart().length
      const trailingWhitespace = raw.length - raw.trimEnd().length
      const start = (match.index ?? 0) + leadingWhitespace
      const end = (match.index ?? 0) + raw.length - trailingWhitespace
      const candidate = text.slice(start, end)

      if (candidate && hasBalancedBraces(candidate)) ranges.push({ start, end })
    }
  }

  collectMatches(BARE_MATH_RELATION)
  collectMatches(BARE_MATH_TOKEN)
  collectMatches(BARE_MATH_ARITHMETIC)

  CJK_SINGLE_VARIABLE.lastIndex = 0
  for (const match of text.matchAll(CJK_SINGLE_VARIABLE)) {
    const start = (match.index ?? 0) + match[1].length
    ranges.push({ start, end: start + match[2].length })
  }

  return ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<MathRange[]>((merged, range) => {
      const previous = merged.at(-1)
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end)
      } else {
        merged.push({ ...range })
      }
      return merged
    }, [])
}

const formatBareMath = (value: string) => {
  let expression = value
    .replace(/\.\.\./g, "\\ldots")
    .replace(/∈/g, "\\in")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/≈/g, "\\approx")
    .replace(/≠/g, "\\ne")
    .replace(/\bR(?=\^)/g, "\\mathbb{R}")

  // 集合的大括号在 LaTeX 中需要转义，否则只会参与分组而不会显示。
  if (/(?:=|\\in)\s*\{/.test(expression)) {
    expression = expression.replace(/((?:=|\\in)\s*)\{/, "$1\\{")
    const closingBrace = expression.lastIndexOf("}")
    if (closingBrace !== -1) {
      expression = `${expression.slice(0, closingBrace)}\\}${expression.slice(closingBrace + 1)}`
    }
  }

  return `$${expression}$`
}

/** 给中文说明中的裸变量、下标、集合及关系式补上行内公式分隔符。 */
const normalizeBareInlineMath = (text: string) => {
  const ranges = collectBareMathRanges(text)
  if (ranges.length === 0) return text

  let result = ""
  let cursor = 0

  for (const range of ranges) {
    result += text.slice(cursor, range.start)
    result += formatBareMath(text.slice(range.start, range.end))
    cursor = range.end
  }

  return result + text.slice(cursor)
}

/** 已经位于 $...$ 或 $$...$$ 中的内容保持原样，只处理公式外的普通文字。 */
const normalizeOutsideDollarMath = (text: string) => {
  let result = ""
  let plainStart = 0
  let cursor = 0

  while (cursor < text.length) {
    if (text[cursor] !== "$" || text[cursor - 1] === "\\") {
      cursor += 1
      continue
    }

    const marker = text[cursor + 1] === "$" ? "$$" : "$"
    let closingIndex = text.indexOf(marker, cursor + marker.length)
    while (closingIndex !== -1 && text[closingIndex - 1] === "\\") {
      closingIndex = text.indexOf(marker, closingIndex + marker.length)
    }

    result += normalizeBareInlineMath(text.slice(plainStart, cursor))
    if (closingIndex === -1) return result + text.slice(cursor)

    const mathEnd = closingIndex + marker.length
    result += text.slice(cursor, mathEnd)
    cursor = mathEnd
    plainStart = cursor
  }

  return result + normalizeBareInlineMath(text.slice(plainStart))
}

const normalizeMathSegment = (segment: string) =>
  normalizeOutsideDollarMath(normalizeMathDelimiters(segment))

const NATURAL_LANGUAGE_FENCE =
  /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*(text|plaintext|plain)?[ \t]*\r?\n([\s\S]*?)\r?\n\2\3[ \t]*(?=\r?\n|$)/gi

/**
 * 模型偶尔会把“其中”“说明如下”一类自然语言误放进 text 代码块。
 * 这里只拆掉短小、没有代码特征的说明文字；命令、日志、配置和真正的代码块仍保持原样。
 */
const unwrapNaturalLanguageFences = (markdown: string) =>
  markdown.replace(
    NATURAL_LANGUAGE_FENCE,
    (
      match,
      leadingLineBreak: string,
      indent: string,
      _marker: string,
      language: string | undefined,
      content: string
    ) => {
      const text = content.trim()
      const lines = text.split(/\r?\n/)
      const containsChinese = /[\u3400-\u9fff]/.test(text)
      const looksLikeEnglishExplanation =
        /^(?:where|note|notes?|explanation)\b/i.test(text)
      const hasCodeLikeContent =
        /(?:^|\n)\s*(?:[$>#]|(?:GET|POST|PUT|PATCH|DELETE)\s+|\d{4}-\d{2}-\d{2})/i.test(
          text
        ) ||
        /(?:https?:\/\/|[{}[\]<>]|=>|===?|:=|;\s*(?:$|\n)|\\[a-zA-Z]+)/.test(
          text
        )

      const isExplanation =
        indent.length === 0 &&
        text.length > 0 &&
        text.length <= 500 &&
        lines.length <= 6 &&
        !hasCodeLikeContent &&
        (containsChinese ||
          (Boolean(language) && looksLikeEnglishExplanation))

      return isExplanation ? `${leadingLineBreak}${text}` : match
    }
  )

/** 只转换普通 Markdown 文本，反引号包裹的行内代码原样返回。 */
const normalizeOutsideInlineCode = (content: string) => {
  let result = ""
  let plainStart = 0
  let cursor = 0

  while (cursor < content.length) {
    if (content[cursor] !== "`") {
      cursor += 1
      continue
    }

    let markerEnd = cursor + 1
    while (content[markerEnd] === "`") markerEnd += 1
    const marker = content.slice(cursor, markerEnd)
    const closingIndex = content.indexOf(marker, markerEnd)

    // 流式输出可能暂时只有起始反引号；此时不要修改后面的未完成代码。
    if (closingIndex === -1) {
      result += normalizeMathSegment(content.slice(plainStart, cursor))
      return result + content.slice(cursor)
    }

    result += normalizeMathSegment(content.slice(plainStart, cursor))
    result += content.slice(cursor, closingIndex + marker.length)
    cursor = closingIndex + marker.length
    plainStart = cursor
  }

  return result + normalizeMathSegment(content.slice(plainStart))
}

interface FenceState {
  character: "`" | "~"
  length: number
}

const getFenceMarker = (line: string) => {
  const match = line.match(/^\s*(`{3,}|~{3,})/)
  if (!match) return null
  return {
    character: match[1][0] as FenceState["character"],
    length: match[1].length,
  }
}

const closesFence = (line: string, fence: FenceState) => {
  const escapedCharacter = fence.character === "`" ? "`" : "~"
  return new RegExp(`^\\s*${escapedCharacter}{${fence.length},}\\s*$`).test(
    line.trimEnd()
  )
}

export function normalizeMarkdownMath(markdown: string) {
  const normalizedMarkdown = unwrapNaturalLanguageFences(markdown)

  const lines =
    normalizedMarkdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []
  let fence: FenceState | null = null
  let plainBuffer = ""
  let result = ""

  const flushPlainBuffer = () => {
    result += normalizeOutsideInlineCode(plainBuffer)
    plainBuffer = ""
  }

  for (const line of lines) {
    if (fence) {
      result += line
      if (closesFence(line, fence)) fence = null
      continue
    }

    const openingFence = getFenceMarker(line)
    if (openingFence) {
      flushPlainBuffer()
      fence = openingFence
      result += line
      continue
    }

    plainBuffer += line
  }

  flushPlainBuffer()
  return result
}
