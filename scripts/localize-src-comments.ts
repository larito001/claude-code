import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import ts from 'typescript'

type CommentBlock = {
  id: number
  start: number
  end: number
  raw: string
  content: string
  indent: string
  kind: 'line' | 'block' | 'jsdoc'
}

type Translation = {
  id: number
  text: string
}

const SOURCE_ROOT = resolve(import.meta.dir, '..', 'src')
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const CJK_PATTERN = /[\u3400-\u9fff]/u
const ENGLISH_WORD_PATTERN = /\b[A-Za-z]{3,}\b/u
const DIRECTIVE_PATTERN = /^(?:\/\s*)?(?:eslint|biome|prettier|stylelint|istanbul|c8|@ts-|webpack|vite|sourceMappingURL|#(?:end)?region)\b/iu
const REFERENCE_PATTERN = /^\/\s*<reference\b/iu

function argumentValue(name: string): string | undefined {
  return process.argv
    .find(argument => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
}

function scopePrefixes(): string[] {
  return (argumentValue('scope') ?? '')
    .split(',')
    .map(prefix => prefix.replaceAll('\\', '/').replace(/^src\//u, '').replace(/\/$/u, ''))
    .filter(Boolean)
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async entry => {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) return collectFiles(path)
        return CODE_EXTENSIONS.has(extname(entry.name)) ? [path] : []
      }),
    )
  ).flat()
}

function isInScope(file: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true
  const path = relative(SOURCE_ROOT, file).replaceAll('\\', '/')
  return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

function normalizeComment(raw: string): string {
  if (raw.startsWith('//')) {
    return raw
      .split(/\r?\n/gu)
      .map(line => line.trimStart().replace(/^\/\/\s?/u, ''))
      .join('\n')
      .trim()
  }
  return raw
    .replace(/^\/\*\*?/u, '')
    .replace(/\*\/$/u, '')
    .split(/\r?\n/gu)
    .map(line => line.replace(/^\s*\*\s?/u, ''))
    .join('\n')
    .trim()
}

function isDirective(content: string): boolean {
  return (
    DIRECTIVE_PATTERN.test(content) ||
    REFERENCE_PATTERN.test(content) ||
    /^https?:\/\//iu.test(content) ||
    /^(?:SPDX-License-Identifier|Copyright)\b/iu.test(content)
  )
}

function lineIndent(source: string, position: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', position - 1) + 1, 0)
  const prefix = source.slice(lineStart, position)
  return /^\s*$/u.test(prefix) ? prefix : ' '.repeat(prefix.length)
}

function collectCommentBlocks(source: string, scriptKind: ts.ScriptKind): CommentBlock[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    scriptKind === ts.ScriptKind.TSX
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard,
    source,
  )
  const ranges: Array<{ start: number; end: number; raw: string }> = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      ranges.push({
        start: scanner.getTokenPos(),
        end: scanner.getTextPos(),
        raw: scanner.getTokenText(),
      })
    }
  }

  const grouped: Array<{ start: number; end: number; raw: string }> = []
  for (const range of ranges) {
    const previous = grouped.at(-1)
    const gap = previous ? source.slice(previous.end, range.start) : ''
    if (
      previous?.raw.trimStart().startsWith('//') &&
      range.raw.trimStart().startsWith('//') &&
      /^\r?\n[\t ]*$/u.test(gap) &&
      lineIndent(source, previous.start) === lineIndent(source, range.start)
    ) {
      previous.end = range.end
      previous.raw = source.slice(previous.start, previous.end)
    } else {
      grouped.push({ ...range })
    }
  }

  return grouped.flatMap((range, id) => {
    const content = normalizeComment(range.raw)
    if (
      !ENGLISH_WORD_PATTERN.test(content) ||
      CJK_PATTERN.test(content) ||
      isDirective(content)
    ) {
      return []
    }
    return [
      {
        id,
        ...range,
        content,
        indent: lineIndent(source, range.start),
        kind: range.raw.startsWith('/**')
          ? 'jsdoc'
          : range.raw.startsWith('//')
            ? 'line'
            : 'block',
      } satisfies CommentBlock,
    ]
  })
}

function cleanTranslation(text: string): string {
  return text
    .replace(/^```(?:text)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .split(/\r?\n/gu)
    .map(line => line.replace(/^\s*(?:\/\/|\/\*\*?|\*\/|\*)\s?/u, ''))
    .join('\n')
    .trim()
}

function renderComment(block: CommentBlock, translatedText: string, eol: string): string {
  const lines = cleanTranslation(translatedText).split(/\r?\n/gu)
  if (block.kind === 'line') {
    return lines.map(line => `//${line ? ` ${line}` : ''}`).join(`${eol}${block.indent}`)
  }
  if (lines.length === 1 && lines[0]!.length <= 100) {
    return block.kind === 'jsdoc'
      ? `/** ${lines[0]} */`
      : `/* ${lines[0]} */`
  }
  const opening = block.kind === 'jsdoc' ? '/**' : '/*'
  const body = lines.map(line => `${block.indent} *${line ? ` ${line}` : ''}`).join(eol)
  return `${opening}${eol}${body}${eol}${block.indent} */`
}

function batches<T>(items: T[], maximumItems: number, maximumCharacters: number): T[][] {
  const output: T[][] = []
  let current: T[] = []
  let characters = 0
  for (const item of items) {
    const size = JSON.stringify(item).length
    if (current.length > 0 && (current.length >= maximumItems || characters + size > maximumCharacters)) {
      output.push(current)
      current = []
      characters = 0
    }
    current.push(item)
    characters += size
  }
  if (current.length > 0) output.push(current)
  return output
}

function responseText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function parseTranslations(text: string, expectedIds: Set<number>): Translation[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('翻译响应中没有 JSON 数组')
  const value: unknown = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(value)) throw new Error('翻译响应不是数组')
  const translations = value.map(item => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof Reflect.get(item, 'id') !== 'number' ||
      typeof Reflect.get(item, 'text') !== 'string'
    ) {
      throw new Error('翻译响应项格式错误')
    }
    return { id: Reflect.get(item, 'id'), text: Reflect.get(item, 'text') } as Translation
  })
  const actualIds = new Set(translations.map(item => item.id))
  if (
    actualIds.size !== expectedIds.size ||
    [...expectedIds].some(id => !actualIds.has(id))
  ) {
    throw new Error('翻译响应缺少或重复注释编号')
  }
  return translations
}

async function translateBatch(
  client: Anthropic,
  model: string,
  items: Array<{ id: number; text: string }>,
): Promise<Translation[]> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        temperature: 0,
        system:
          '你是 TypeScript 源码注释翻译器。把英文自然语言准确、简洁地翻译成中文；保留代码标识符、文件名、环境变量、命令、数值、JSDoc 标签和 Markdown 代码。不要保留可翻译的英文句子，不要改变技术含义，不要添加解释。只返回 JSON 数组，每项格式为 {"id":数字,"text":"译文"}。',
        messages: [
          {
            role: 'user',
            content: JSON.stringify(items),
          },
        ],
      })
      return parseTranslations(responseText(response), new Set(items.map(item => item.id)))
    } catch (error) {
      lastError = error
      if (attempt < 3) await Bun.sleep(500 * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

async function localizeFile(client: Anthropic, model: string, file: string): Promise<number> {
  const source = await readFile(file, 'utf8')
  const blocks = collectCommentBlocks(
    source,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (blocks.length === 0) return 0

  const translated = new Map<number, string>()
  for (const batch of batches(blocks, 24, 14000)) {
    const results = await translateBatch(
      client,
      model,
      batch.map(block => ({ id: block.id, text: block.content })),
    )
    for (const result of results) translated.set(result.id, result.text)
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  let output = source
  for (const block of blocks.toReversed()) {
    const translation = translated.get(block.id)
    if (!translation) throw new Error(`缺少注释 ${block.id} 的翻译`)
    output =
      output.slice(0, block.start) +
      renderComment(block, translation, eol) +
      output.slice(block.end)
  }
  await writeFile(file, output, 'utf8')
  return blocks.length
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY
  const baseURL = process.env.ANTHROPIC_BASE_URL
  const model =
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    'deepseek-v4-flash'
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY')
  if (!baseURL) throw new Error('缺少 ANTHROPIC_BASE_URL')

  const prefixes = scopePrefixes()
  const files = (await collectFiles(SOURCE_ROOT)).filter(file => isInScope(file, prefixes))
  const client = new Anthropic({ apiKey, baseURL })
  let total = 0
  for (const [index, file] of files.entries()) {
    const count = await localizeFile(client, model, file)
    total += count
    if (count > 0) {
      console.log(
        `[${index + 1}/${files.length}] ${relative(resolve(SOURCE_ROOT, '..'), file)}：${count} 组`,
      )
    }
  }
  console.log(`已翻译 ${total} 组英文注释。`)
}

await main()
