#!/usr/bin/env bun
/**
 * Core framework Config UI Server
 * A lightweight web dashboard for managing framework settings.
 * Run: bun run config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'fs'
import { join, dirname, resolve, relative, isAbsolute } from 'path'
import { getFrameworkConfigHomeDir } from '../src/utils/envUtils.js'
import { getSettingsFilePathForSource } from '../src/utils/settings/settings.js'
import { getAutoMemPath } from '../src/memdir/paths.js'
import { getOriginalCwd } from '../src/bootstrap/state.js'
import { getDefaultFeatures, getOptionalFeatures } from '../src/utils/features.js'

const CWD = getOriginalCwd()
const APP_ROOT = resolve(import.meta.dir, '..')
const FRAMEWORK_DIR = getFrameworkConfigHomeDir()
const PROJECT_FRAMEWORK_DIR = join(CWD, '.claude-code-core-framework')
const CONFIGURED_PORT = process.env.CONFIG_PORT
const PORT = CONFIGURED_PORT === undefined ? 3456 : Number(CONFIGURED_PORT)

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error('CONFIG_PORT must be an integer between 0 and 65535')
}

type ConfigScope = 'user' | 'project'
type ClaudeMdTarget = 'user' | 'project' | 'projectFramework' | 'local'

// --- Path Helpers ---

function getUserSettingsPath() {
  return getSettingsFilePathForSource('userSettings')
}

function getProjectSettingsPath() {
  return getSettingsFilePathForSource('projectSettings')
}

function getLocalSettingsPath() {
  return getSettingsFilePathForSource('localSettings')
}

function getMcpConfigPath() {
  return join(CWD, '.mcp.json')
}

function getAgentsDir(scope: ConfigScope = 'project') {
  return join(scope === 'user' ? FRAMEWORK_DIR : PROJECT_FRAMEWORK_DIR, 'agents')
}

function getSkillsDir(scope: ConfigScope = 'project') {
  return join(scope === 'user' ? FRAMEWORK_DIR : PROJECT_FRAMEWORK_DIR, 'skills')
}

function getMemoryDir() {
  return getAutoMemPath()
}

function getEnvPath() {
  const configuredPath = process.env.CONFIG_UI_ENV_PATH
  return configuredPath ? resolve(CWD, configuredPath) : join(APP_ROOT, '.env')
}

function getClaudeMdPaths(): Record<ClaudeMdTarget, string> {
  return {
    user: join(FRAMEWORK_DIR, 'CLAUDE.md'),
    project: join(CWD, 'CLAUDE.md'),
    projectFramework: join(PROJECT_FRAMEWORK_DIR, 'CLAUDE.md'),
    local: join(CWD, 'CLAUDE.local.md'),
  }
}

function getRulesDir(scope: ConfigScope = 'project') {
  return join(scope === 'user' ? FRAMEWORK_DIR : PROJECT_FRAMEWORK_DIR, 'rules')
}

function parseScope(value: unknown): ConfigScope | null {
  if (value === undefined) return 'project'
  return value === 'user' || value === 'project' ? value : null
}

function portableName(value: unknown, stripMd = false): string | null {
  if (typeof value !== 'string') return null
  let name = value.trim()
  if (stripMd && name.toLowerCase().endsWith('.md')) name = name.slice(0, -3)
  if (!name || name.length > 128 || name === '.' || name === '..' || name.endsWith('.')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return null
  return name
}

function resolveWithin(root: string, ...parts: string[]) {
  const rootPath = resolve(root)
  const target = resolve(rootPath, ...parts)
  const rel = relative(rootPath, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes configured directory')
  return target
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 })
}

// --- File I/O Helpers ---

function readJsonSafe(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeJsonSafe(path: string, data: any) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function readTextSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

function writeTextSafe(path: string, content: string) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, content)
}

function removeDirIfEmpty(path: string) {
  if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path)
}

function listMdFiles(dir: string): Array<{ name: string; path: string; content: string }> {
  if (!existsSync(dir)) return []
  const results: Array<{ name: string; path: string; content: string }> = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const p = join(dir, entry.name)
        results.push({ name: entry.name, path: p, content: readTextSafe(p) })
      } else if (entry.isDirectory()) {
        // Check for SKILL.md or other Markdown files inside subdirectory
        const skillMd = join(dir, entry.name, 'SKILL.md')
        if (existsSync(skillMd)) {
          results.push({ name: entry.name, path: skillMd, content: readTextSafe(skillMd) })
        } else {
          // List .md files inside subdirectory
          for (const sub of readdirSync(join(dir, entry.name))) {
            if (sub.endsWith('.md')) {
              const p = join(dir, entry.name, sub)
              results.push({ name: `${entry.name}/${sub}`, path: p, content: readTextSafe(p) })
            }
          }
        }
      }
    }
  } catch {}
  return results
}

// --- Feature Flags ---

const DEFAULT_FEATURES = new Set(getDefaultFeatures())
const CONFIGURABLE_FEATURES = [
  ...getDefaultFeatures(),
  ...getOptionalFeatures(),
] as const

function readEnvValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm'))
  return (match?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
}

function parseFeatureList(value: string): Set<string> {
  return new Set(value.split(',').map(name => name.trim()).filter(Boolean))
}

function parseFeatureFlags(): Record<string, boolean> {
  const content = readTextSafe(getEnvPath())
  const enabled = parseFeatureList(readEnvValue(content, 'CLAUDE_CODE_FEATURES'))
  const disabled = parseFeatureList(readEnvValue(content, 'CLAUDE_CODE_DISABLE_FEATURES'))
  return Object.fromEntries(
    CONFIGURABLE_FEATURES.map(name => [
      name,
      !disabled.has(name) && (DEFAULT_FEATURES.has(name) || enabled.has(name)),
    ]),
  )
}

function setEnvValues(values: Record<string, string>): void {
  const envPath = getEnvPath()
  const existing = readTextSafe(envPath)
  const lines = existing ? existing.replace(/\r\n/g, '\n').split('\n') : []

  for (const [key, value] of Object.entries(values)) {
    const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
    const index = lines.findIndex(line => matcher.test(line))
    const replacement = `${key}=${value}`
    if (index >= 0) lines[index] = replacement
    else lines.push(replacement)
  }

  writeTextSafe(envPath, `${lines.filter((line, index) => index < lines.length - 1 || line).join('\n')}\n`)
}

function writeFeatureFlags(flags: Record<string, boolean>): void {
  const invalid = Object.keys(flags).find(
    name => !CONFIGURABLE_FEATURES.includes(name as typeof CONFIGURABLE_FEATURES[number]),
  )
  if (invalid) throw new Error(`Unsupported feature: ${invalid}`)

  const enabled = CONFIGURABLE_FEATURES.filter(
    name => !DEFAULT_FEATURES.has(name) && flags[name] === true,
  )
  const disabled = CONFIGURABLE_FEATURES.filter(
    name => DEFAULT_FEATURES.has(name) && flags[name] === false,
  )
  setEnvValues({
    CLAUDE_CODE_FEATURES: enabled.join(','),
    CLAUDE_CODE_DISABLE_FEATURES: disabled.join(','),
  })
}

// --- API Router ---

async function handleAPI(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // --- Settings ---
  if (path === '/api/settings' && req.method === 'GET') {
    return Response.json({
      user: readJsonSafe(getUserSettingsPath()),
      project: readJsonSafe(getProjectSettingsPath()),
      local: readJsonSafe(getLocalSettingsPath()),
    })
  }

  if (path === '/api/settings' && req.method === 'POST') {
    const body = await req.json() as { scope: string; settings: any }
    const pathMap: Record<string, string> = {
      user: getUserSettingsPath(),
      project: getProjectSettingsPath(),
      local: getLocalSettingsPath(),
    }
    const target = pathMap[body.scope]
    if (!target) return Response.json({ error: 'Invalid scope' }, { status: 400 })
    writeJsonSafe(target, body.settings)
    return Response.json({ ok: true })
  }

  // --- Feature Flags ---
  if (path === '/api/features' && req.method === 'GET') {
    return Response.json(parseFeatureFlags())
  }

  if (path === '/api/features' && req.method === 'POST') {
    const flags = await req.json() as Record<string, boolean>
    try {
      writeFeatureFlags(flags)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'Invalid feature configuration')
    }
    return Response.json({ ok: true })
  }

  // --- MCP Servers ---
  if (path === '/api/mcp' && req.method === 'GET') {
    return Response.json(readJsonSafe(getMcpConfigPath()))
  }

  if (path === '/api/mcp' && req.method === 'POST') {
    const config = await req.json()
    writeJsonSafe(getMcpConfigPath(), config)
    return Response.json({ ok: true })
  }

  // --- Agents ---
  if (path === '/api/agents' && req.method === 'GET') {
    return Response.json((['user', 'project'] as const).flatMap(scope =>
      listMdFiles(getAgentsDir(scope)).map(agent => ({ ...agent, scope })),
    ))
  }

  if (path === '/api/agents' && req.method === 'POST') {
    const body = await req.json() as { name?: unknown; content?: unknown; scope?: unknown }
    const scope = parseScope(body.scope)
    const name = portableName(body.name, true)
    if (!scope) return badRequest('Invalid scope')
    if (!name) return badRequest('Invalid portable agent name')
    if (typeof body.content !== 'string') return badRequest('Invalid content')
    const agentPath = resolveWithin(getAgentsDir(scope), `${name}.md`)
    writeTextSafe(agentPath, body.content)
    return Response.json({ ok: true })
  }

  if (path === '/api/agents' && req.method === 'DELETE') {
    const body = await req.json() as { name?: unknown; scope?: unknown }
    const scope = parseScope(body.scope)
    const name = portableName(body.name, true)
    if (!scope) return badRequest('Invalid scope')
    if (!name) return badRequest('Invalid portable agent name')
    const agentPath = resolveWithin(getAgentsDir(scope), `${name}.md`)
    if (existsSync(agentPath)) unlinkSync(agentPath)
    removeDirIfEmpty(getAgentsDir(scope))
    return Response.json({ ok: true })
  }

  // --- Skills ---
  if (path === '/api/skills' && req.method === 'GET') {
    return Response.json((['user', 'project'] as const).flatMap(scope =>
      listMdFiles(getSkillsDir(scope)).map(skill => ({ ...skill, scope })),
    ))
  }

  if (path === '/api/skills' && req.method === 'POST') {
    const body = await req.json() as { name?: unknown; content?: unknown; scope?: unknown }
    const scope = parseScope(body.scope)
    const name = portableName(body.name)
    if (!scope) return badRequest('Invalid scope')
    if (!name) return badRequest('Invalid portable skill name')
    if (typeof body.content !== 'string') return badRequest('Invalid content')
    const skillDir = resolveWithin(getSkillsDir(scope), name)
    const skillPath = resolveWithin(skillDir, 'SKILL.md')
    writeTextSafe(skillPath, body.content)
    return Response.json({ ok: true })
  }

  if (path === '/api/skills' && req.method === 'DELETE') {
    const body = await req.json() as { name?: unknown; scope?: unknown }
    const scope = parseScope(body.scope)
    const name = portableName(body.name)
    if (!scope) return badRequest('Invalid scope')
    if (!name) return badRequest('Invalid portable skill name')
    const skillDir = resolveWithin(getSkillsDir(scope), name)
    const skillPath = resolveWithin(skillDir, 'SKILL.md')
    if (existsSync(skillPath)) unlinkSync(skillPath)
    removeDirIfEmpty(skillDir)
    removeDirIfEmpty(getSkillsDir(scope))
    return Response.json({ ok: true })
  }

  // --- Memory ---
  if (path === '/api/memory' && req.method === 'GET') {
    return Response.json(listMdFiles(getMemoryDir()))
  }

  // --- CLAUDE.md ---
  if (path === '/api/claudemd' && req.method === 'GET') {
    const paths = getClaudeMdPaths()
    const files = Object.fromEntries(Object.entries(paths).map(([target, filePath]) => [
      target,
      { path: filePath, content: readTextSafe(filePath) },
    ]))
    const rules = (['user', 'project'] as const).flatMap(scope =>
      listMdFiles(getRulesDir(scope)).map(rule => ({ ...rule, scope })),
    )
    return Response.json({ files, rules })
  }

  if (path === '/api/claudemd' && req.method === 'POST') {
    const body = await req.json() as { content?: unknown; target?: unknown }
    if (typeof body.content !== 'string') return badRequest('Invalid content')
    const paths = getClaudeMdPaths()
    const target = paths[body.target as ClaudeMdTarget]
    if (!target) return badRequest('Invalid CLAUDE.md target')
    writeTextSafe(target, body.content)
    return Response.json({ ok: true })
  }

  // --- Info ---
  if (path === '/api/info' && req.method === 'GET') {
    return Response.json({
      cwd: CWD,
      frameworkDir: FRAMEWORK_DIR,
      settingsPaths: {
        user: getUserSettingsPath(),
        project: getProjectSettingsPath(),
        local: getLocalSettingsPath(),
      },
      agentsDir: getAgentsDir('project'),
      agentsDirs: { user: getAgentsDir('user'), project: getAgentsDir('project') },
      skillsDir: getSkillsDir('project'),
      skillsDirs: { user: getSkillsDir('user'), project: getSkillsDir('project') },
      memoryDir: getMemoryDir(),
      mcpConfigPath: getMcpConfigPath(),
      claudeMdPaths: getClaudeMdPaths(),
      rulesDirs: { user: getRulesDir('user'), project: getRulesDir('project') },
      envPath: getEnvPath(),
    })
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}

// --- HTML Serving ---

const HTML_PATH = join(import.meta.dir, 'index.html')

// --- Server ---

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      return handleAPI(req)
    }

    // Serve index.html for all other routes
    if (existsSync(HTML_PATH)) {
      return new Response(readFileSync(HTML_PATH, 'utf-8'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Config UI not found', { status: 404 })
  },
})

console.log(`
  Core Framework Config UI
  http://localhost:${server.port}

  Working directory: ${CWD}
  Settings: ${getUserSettingsPath()}
`)

// Try to open browser
if (process.env.CONFIG_UI_NO_OPEN !== '1') try {
  const { exec } = require('child_process')
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} http://localhost:${server.port}`)
} catch {}
