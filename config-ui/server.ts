#!/usr/bin/env bun
/**
 * Claude Code Config UI Server
 * A lightweight web dashboard for managing all Claude Code settings.
 * Run: bun run config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'fs'
import { join, dirname, resolve, relative, isAbsolute } from 'path'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.js'
import { getSettingsFilePathForSource } from '../src/utils/settings/settings.js'
import { getAutoMemPath } from '../src/memdir/paths.js'
import { getOriginalCwd } from '../src/bootstrap/state.js'

const PORT = Number(process.env.CONFIG_PORT) || 3456
const CWD = getOriginalCwd()
const APP_ROOT = resolve(import.meta.dir, '..')
const CLAUDE_DIR = getClaudeConfigHomeDir()

type ConfigScope = 'user' | 'project'
type ClaudeMdTarget = 'user' | 'project' | 'projectDotClaude' | 'local'

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
  return join(scope === 'user' ? CLAUDE_DIR : join(CWD, '.claude'), 'agents')
}

function getSkillsDir(scope: ConfigScope = 'project') {
  return join(scope === 'user' ? CLAUDE_DIR : join(CWD, '.claude'), 'skills')
}

function getMemoryDir() {
  return getAutoMemPath()
}

function getBundlePolyfillPath() {
  return join(APP_ROOT, 'node_modules', 'bundle', 'index.js')
}

function getClaudeMdPaths(): Record<ClaudeMdTarget, string> {
  return {
    user: join(CLAUDE_DIR, 'CLAUDE.md'),
    project: join(CWD, 'CLAUDE.md'),
    projectDotClaude: join(CWD, '.claude', 'CLAUDE.md'),
    local: join(CWD, 'CLAUDE.local.md'),
  }
}

function getLegacyClaudeMdPath() {
  const paths = getClaudeMdPaths()
  if (existsSync(paths.projectDotClaude)) return paths.projectDotClaude
  return paths.project
}

function getRulesDir(scope: ConfigScope = 'project') {
  return join(scope === 'user' ? CLAUDE_DIR : join(CWD, '.claude'), 'rules')
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

function parseFeatureFlags(): Record<string, boolean> {
  const content = readTextSafe(getBundlePolyfillPath())
  const flags: Record<string, boolean> = {}
  const allFlags = [
    'KAIROS', 'PROACTIVE', 'COORDINATOR_MODE',
    'TRANSCRIPT_CLASSIFIER', 'BASH_CLASSIFIER', 'BUDDY', 'WEB_BROWSER_TOOL',
    'AGENT_TRIGGERS', 'MONITOR_TOOL', 'TEAMMEM',
    'EXTRACT_MEMORIES', 'MCP_SKILLS', 'REVIEW_ARTIFACT', 'CONNECTOR_TEXT',
    'DOWNLOAD_USER_SETTINGS', 'MESSAGE_ACTIONS', 'KAIROS_CHANNELS', 'KAIROS_GITHUB_WEBHOOKS',
  ]
  for (const flag of allFlags) {
    // Check if the flag line is uncommented (enabled)
    const enabledRegex = new RegExp(`^\\s*'${flag}'`, 'm')
    const commentedRegex = new RegExp(`^\\s*//\\s*'${flag}'`, 'm')
    flags[flag] = enabledRegex.test(content) && !commentedRegex.test(content)
  }
  return flags
}

function writeFeatureFlags(flags: Record<string, boolean>) {
  const descriptions: Record<string, string> = {
    KAIROS: 'Assistant / daily-log mode',
    PROACTIVE: 'Proactive autonomous mode',
    COORDINATOR_MODE: 'Multi-agent swarm coordinator',
    TRANSCRIPT_CLASSIFIER: 'Auto-mode permission classifier',
    BASH_CLASSIFIER: 'Bash command safety classifier',
    BUDDY: 'Companion sprite animation',
    WEB_BROWSER_TOOL: 'In-process web browser tool',
    AGENT_TRIGGERS: 'Scheduled cron agents',
    MONITOR_TOOL: 'MCP server monitoring',
    TEAMMEM: 'Shared team memory',
    EXTRACT_MEMORIES: 'Background memory extraction agent',
    MCP_SKILLS: 'Skills from MCP servers',
    REVIEW_ARTIFACT: 'Review artifact tool',
    CONNECTOR_TEXT: 'Connector text blocks',
    DOWNLOAD_USER_SETTINGS: 'Remote settings sync',
    MESSAGE_ACTIONS: 'Message action buttons',
    KAIROS_CHANNELS: 'Channel notifications',
    KAIROS_GITHUB_WEBHOOKS: 'GitHub webhook integration',
  }

  const lines = Object.entries(flags).map(([flag, enabled]) => {
    const desc = descriptions[flag] || flag
    return enabled
      ? `  '${flag}', // ${desc}`
      : `  // '${flag}', // ${desc}`
  })

  const content = `// Runtime polyfill for bun:bundle feature() function
// Managed by Claude Code Config UI

const ENABLED_FEATURES = new Set([
${lines.join('\n')}
])

module.exports.feature = function feature(name) {
  return ENABLED_FEATURES.has(name)
}
`
  writeTextSafe(getBundlePolyfillPath(), content)
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
    writeFeatureFlags(flags)
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
    const legacyPath = getLegacyClaudeMdPath()
    const rules = (['user', 'project'] as const).flatMap(scope =>
      listMdFiles(getRulesDir(scope)).map(rule => ({ ...rule, scope })),
    )
    return Response.json({ claudeMd: readTextSafe(legacyPath), path: legacyPath, files, rules })
  }

  if (path === '/api/claudemd' && req.method === 'POST') {
    const body = await req.json() as { content?: unknown; target?: unknown }
    if (typeof body.content !== 'string') return badRequest('Invalid content')
    const paths = getClaudeMdPaths()
    const target = body.target === undefined ? getLegacyClaudeMdPath() : paths[body.target as ClaudeMdTarget]
    if (!target) return badRequest('Invalid CLAUDE.md target')
    writeTextSafe(target, body.content)
    return Response.json({ ok: true })
  }

  // --- Info ---
  if (path === '/api/info' && req.method === 'GET') {
    return Response.json({
      cwd: CWD,
      claudeDir: CLAUDE_DIR,
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
      bundlePath: getBundlePolyfillPath(),
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
  Claude Code Config UI
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
