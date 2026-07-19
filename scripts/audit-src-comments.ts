import { readdir, readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import ts from 'typescript'

type Finding = {
  file: string
  line: number
  subject: string
}

type AuditResult = {
  files: number
  documentedMethods: number
  missingMethodComments: Finding[]
  englishComments: Finding[]
}

const SOURCE_ROOT = resolve(import.meta.dir, '..', 'src')
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const CJK_PATTERN = /[\u3400-\u9fff]/u
const ENGLISH_WORD_PATTERN = /\b[A-Za-z]{3,}\b/u
const COMMENT_DIRECTIVE_PATTERN = /^(?:\/\s*)?(?:eslint|biome|prettier|stylelint|istanbul|c8|@ts-|webpack|vite|sourceMappingURL|#(?:end)?region)\b/iu
const REFERENCE_DIRECTIVE_PATTERN = /^\/\s*<reference\b/iu
const STANDALONE_JSDOC_TAG_PATTERN = /^@(?:internal|public|private|protected|packageDocumentation|inheritdoc)\s*$/iu

function getScopePrefixes(): string[] {
  const scopeArgument = process.argv.find(argument => argument.startsWith('--scope='))
  if (!scopeArgument) return []
  return scopeArgument
    .slice('--scope='.length)
    .split(',')
    .map(prefix => prefix.replaceAll('\\', '/').replace(/^src\//u, '').replace(/\/$/u, ''))
    .filter(Boolean)
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async entry => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return collectSourceFiles(path)
      return CODE_EXTENSIONS.has(extname(entry.name)) ? [path] : []
    }),
  )
  return files.flat()
}

function isInScope(file: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true
  const sourceRelativePath = relative(SOURCE_ROOT, file).replaceAll('\\', '/')
  return prefixes.some(
    prefix => sourceRelativePath === prefix || sourceRelativePath.startsWith(`${prefix}/`),
  )
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1
}

function displayName(name: ts.PropertyName | ts.BindingName | undefined): string {
  if (!name) return '匿名方法'
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return name.getText()
}

function containsCallableExpression(expression: ts.Expression | undefined): boolean {
  if (!expression) return false
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return containsCallableExpression(expression.expression)
  if (ts.isCallExpression(expression)) {
    return expression.arguments.some(argument =>
      ts.isExpression(argument) ? containsCallableExpression(argument) : false,
    )
  }
  return false
}

function isFunctionTypedProperty(node: ts.PropertyDeclaration | ts.PropertySignature): boolean {
  return (
    (ts.isPropertyDeclaration(node) && containsCallableExpression(node.initializer)) ||
    node.type?.kind === ts.SyntaxKind.FunctionType
  )
}

function getDocumentationRanges(
  sourceText: string,
  node: ts.Node,
): ts.CommentRange[] {
  const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? []
  const adjacent: ts.CommentRange[] = []
  let cursor = node.getStart()
  for (const range of ranges.toReversed()) {
    if (sourceText.slice(range.end, cursor).trim() !== '') break
    adjacent.unshift(range)
    cursor = range.pos
  }
  return adjacent
}

function hasChineseDocumentation(sourceText: string, node: ts.Node): boolean {
  return getDocumentationRanges(sourceText, node).some(range =>
    CJK_PATTERN.test(sourceText.slice(range.pos, range.end)),
  )
}

function addMethodFinding(
  result: AuditResult,
  sourceFile: ts.SourceFile,
  sourceText: string,
  node: ts.Node,
  subject: string,
): void {
  if (hasChineseDocumentation(sourceText, node)) {
    result.documentedMethods += 1
    return
  }
  result.missingMethodComments.push({
    file: relative(resolve(SOURCE_ROOT, '..'), sourceFile.fileName).replaceAll('\\', '/'),
    line: lineOf(sourceFile, node.getStart()),
    subject,
  })
}

function auditMethodComments(
  result: AuditResult,
  sourceFile: ts.SourceFile,
  sourceText: string,
): void {
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) {
      addMethodFinding(
        result,
        sourceFile,
        sourceText,
        node,
        displayName(node.name),
      )
    } else if (ts.isConstructorDeclaration(node)) {
      addMethodFinding(result, sourceFile, sourceText, node, 'constructor')
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      addMethodFinding(
        result,
        sourceFile,
        sourceText,
        node,
        displayName(node.name),
      )
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!containsCallableExpression(declaration.initializer)) continue
        addMethodFinding(
          result,
          sourceFile,
          sourceText,
          node,
          displayName(declaration.name),
        )
      }
    } else if (
      (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
      isFunctionTypedProperty(node)
    ) {
      addMethodFinding(
        result,
        sourceFile,
        sourceText,
        node,
        displayName(node.name),
      )
    } else if (
      ts.isPropertyAssignment(node) &&
      containsCallableExpression(node.initializer)
    ) {
      addMethodFinding(
        result,
        sourceFile,
        sourceText,
        node,
        displayName(node.name),
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function normalizeComment(comment: string): string {
  return comment
    .replace(/^\/\/?\*+|\*+\/$/gu, '')
    .replace(/^\/\//gu, '')
    .replace(/^\s*\*\s?/gmu, '')
    .trim()
}

function isToolDirective(comment: string): boolean {
  const normalized = normalizeComment(comment)
  return (
    COMMENT_DIRECTIVE_PATTERN.test(normalized) ||
    REFERENCE_DIRECTIVE_PATTERN.test(normalized) ||
    STANDALONE_JSDOC_TAG_PATTERN.test(normalized) ||
    /^https?:\/\//iu.test(normalized) ||
    /^(?:SPDX-License-Identifier|Copyright)\b/iu.test(normalized)
  )
}

function auditEnglishComments(
  result: AuditResult,
  sourceFile: ts.SourceFile,
  sourceText: string,
): void {
  const ranges = new Map<string, ts.CommentRange>()
  function collect(node: ts.Node): void {
    for (const range of ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range)
    }
    for (const range of ts.getTrailingCommentRanges(sourceText, node.getEnd()) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range)
    }
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  for (const range of [...ranges.values()].toSorted((left, right) => left.pos - right.pos)) {
    const comment = sourceText.slice(range.pos, range.end)
    if (
      !ENGLISH_WORD_PATTERN.test(comment) ||
      CJK_PATTERN.test(comment) ||
      isToolDirective(comment)
    ) {
      continue
    }
    result.englishComments.push({
      file: relative(resolve(SOURCE_ROOT, '..'), sourceFile.fileName).replaceAll('\\', '/'),
      line: lineOf(sourceFile, range.pos),
      subject: normalizeComment(comment).replace(/\s+/gu, ' ').slice(0, 120),
    })
  }
}

function printFindings(title: string, findings: Finding[]): void {
  console.log(`${title}: ${findings.length}`)
  for (const finding of findings.slice(0, 100)) {
    console.log(`  ${finding.file}:${finding.line} ${finding.subject}`)
  }
  if (findings.length > 100) console.log(`  ……另有 ${findings.length - 100} 项`)
}

async function main(): Promise<void> {
  const prefixes = getScopePrefixes()
  const sourceFiles = (await collectSourceFiles(SOURCE_ROOT)).filter(file =>
    isInScope(file, prefixes),
  )
  const result: AuditResult = {
    files: sourceFiles.length,
    documentedMethods: 0,
    missingMethodComments: [],
    englishComments: [],
  }
  for (const file of sourceFiles) {
    const sourceText = await readFile(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    auditMethodComments(result, sourceFile, sourceText)
    auditEnglishComments(result, sourceFile, sourceText)
  }

  console.log(`已扫描源码文件: ${result.files}`)
  console.log(`已有中文注释的方法: ${result.documentedMethods}`)
  printFindings('缺少中文注释的方法', result.missingMethodComments)
  printFindings('仍为英文的自然语言注释', result.englishComments)
  if (result.missingMethodComments.length > 0 || result.englishComments.length > 0) {
    process.exitCode = 1
  }
}

await main()
