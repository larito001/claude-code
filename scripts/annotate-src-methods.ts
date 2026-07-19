import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import ts from 'typescript'

type DocumentationTarget = {
  node: ts.Node
  names: string[]
}

const SOURCE_ROOT = resolve(import.meta.dir, '..', 'src')
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const CJK_PATTERN = /[\u3400-\u9fff]/u

function scopePrefixes(): string[] {
  const value = process.argv
    .find(argument => argument.startsWith('--scope='))
    ?.slice('--scope='.length)
  return (value ?? '')
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

function displayName(name: ts.PropertyName | ts.BindingName | undefined): string {
  if (!name) return 'anonymous'
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return name.getText()
}

function containsCallable(expression: ts.Expression | undefined): boolean {
  if (!expression) return false
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return containsCallable(expression.expression)
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.some(argument =>
      ts.isExpression(argument) ? containsCallable(argument) : false,
    )
  )
}

function isFunctionProperty(node: ts.PropertyDeclaration | ts.PropertySignature): boolean {
  return (
    (ts.isPropertyDeclaration(node) && containsCallable(node.initializer)) ||
    node.type?.kind === ts.SyntaxKind.FunctionType
  )
}

function hasChineseDocumentation(source: string, node: ts.Node): boolean {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []
  return ranges.some(
    range =>
      source.slice(range.end, node.getStart()).trim() === '' &&
      CJK_PATTERN.test(source.slice(range.pos, range.end)),
  )
}

function addTarget(
  targets: Map<number, DocumentationTarget>,
  source: string,
  node: ts.Node,
  name: string,
): void {
  if (hasChineseDocumentation(source, node)) return
  const position = node.getStart()
  const existing = targets.get(position)
  if (existing) {
    existing.names.push(name)
  } else {
    targets.set(position, { node, names: [name] })
  }
}

function collectTargets(sourceFile: ts.SourceFile, source: string): DocumentationTarget[] {
  const targets = new Map<number, DocumentationTarget>()
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) {
      addTarget(targets, source, node, displayName(node.name))
    } else if (ts.isConstructorDeclaration(node)) {
      addTarget(targets, source, node, 'constructor')
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      addTarget(targets, source, node, displayName(node.name))
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (containsCallable(declaration.initializer)) {
          addTarget(targets, source, node, displayName(declaration.name))
        }
      }
    } else if (
      (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
      isFunctionProperty(node)
    ) {
      addTarget(targets, source, node, displayName(node.name))
    } else if (ts.isPropertyAssignment(node) && containsCallable(node.initializer)) {
      addTarget(targets, source, node, displayName(node.name))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...targets.values()]
}

function splitName(name: string): string {
  return name
    .replace(/_/gu, ' ')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .trim()
}

function describeSingleName(name: string): string {
  if (name === 'constructor') return '初始化当前实例及其必要状态。'
  if (name === 'main') return '执行当前模块的主流程。'
  if (name === 'assert') return '校验给定条件，不满足时抛出错误。'
  if (name === 'render') return '渲染当前视图。'
  if (name === 'observe') return '订阅并观察状态变化。'
  const readable = splitName(name)
  if (/^[A-Z]/u.test(name)) return `渲染 ${readable} 组件。`

  const rules: Array<[RegExp, string]> = [
    [/^use(?=[A-Z])/u, '管理'],
    [/^(?:get|read|load|fetch|find|lookup|select)/iu, '获取'],
    [/^(?:set|save|write|store|persist)/iu, '设置并保存'],
    [/^(?:create|make|build|construct|new)/iu, '创建'],
    [/^(?:parse|decode|deserialize)/iu, '解析'],
    [/^(?:format|encode|serialize|stringify)/iu, '格式化'],
    [/^(?:validate|verify|assert)/iu, '校验'],
    [/^(?:is|has|can|should|supports|matches)/iu, '判断是否满足'],
    [/^(?:handle|on|process|dispatch)/iu, '处理'],
    [/^(?:add|append|insert|push|register)/iu, '添加或注册'],
    [/^(?:remove|delete|clear|dispose|destroy|unregister)/iu, '删除或清理'],
    [/^(?:update|refresh|sync|reconcile)/iu, '更新'],
    [/^(?:start|launch|open|enable|activate)/iu, '启动或启用'],
    [/^(?:stop|close|disable|deactivate|cancel|abort)/iu, '停止或关闭'],
    [/^(?:run|execute|perform|invoke|call)/iu, '执行'],
    [/^(?:resolve|determine|choose|pick)/iu, '确定'],
    [/^(?:convert|transform|map|to)/iu, '转换'],
    [/^(?:calculate|compute|count|measure|estimate)/iu, '计算'],
    [/^(?:check|detect|inspect|scan)/iu, '检查'],
    [/^(?:normalize|sanitize|clean)/iu, '规范化'],
    [/^(?:merge|combine|join|aggregate|collect)/iu, '合并或收集'],
    [/^(?:sort|filter|group)/iu, '整理'],
    [/^(?:reset|restore|recover)/iu, '重置或恢复'],
    [/^(?:wait|await)/iu, '等待'],
    [/^(?:log|report|emit|notify|send|print)/iu, '输出或发送'],
  ]
  for (const [pattern, verb] of rules) {
    if (pattern.test(name)) return `${verb} ${readable} 对应的数据或状态。`
  }
  return `执行 ${readable} 对应的业务处理。`
}

function description(names: string[]): string {
  const uniqueNames = [...new Set(names)]
  if (uniqueNames.length === 1) return describeSingleName(uniqueNames[0]!)
  return `提供 ${uniqueNames.map(splitName).join('、')} 的处理逻辑。`
}

function indentation(sourceFile: ts.SourceFile, position: number): string {
  const { character } = sourceFile.getLineAndCharacterOfPosition(position)
  const lineStart = position - character
  const prefix = sourceFile.text.slice(lineStart, position)
  return /^\s*$/u.test(prefix) ? prefix : ' '.repeat(character)
}

async function annotateFile(file: string): Promise<number> {
  const source = await readFile(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const targets = collectTargets(sourceFile, source)
  if (targets.length === 0) return 0
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  let output = source
  for (const target of targets.toSorted((left, right) => right.node.getStart() - left.node.getStart())) {
    const position = target.node.getStart()
    const indent = indentation(sourceFile, position)
    output =
      output.slice(0, position) +
      `/** ${description(target.names)} */${eol}${indent}` +
      output.slice(position)
  }
  await writeFile(file, output, 'utf8')
  return targets.length
}

async function main(): Promise<void> {
  const prefixes = scopePrefixes()
  const files = (await collectFiles(SOURCE_ROOT)).filter(file => isInScope(file, prefixes))
  let total = 0
  for (const file of files) {
    const count = await annotateFile(file)
    total += count
    if (count > 0) {
      console.log(`${relative(resolve(SOURCE_ROOT, '..'), file)}：新增 ${count} 条方法注释`)
    }
  }
  console.log(`已新增 ${total} 条中文方法注释。`)
}

await main()
