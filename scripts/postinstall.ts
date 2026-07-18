import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// bun:bundle is compile-time-only in production. Source-mode development uses
// this package as a small runtime feature-flag polyfill.
const bundleDir = join(process.cwd(), 'node_modules', 'bundle')

const enabledFeatures = [
  // 'KAIROS',
  // 'PROACTIVE',
  // 'BRIDGE_MODE',
  // 'VOICE_MODE',
  // 'COORDINATOR_MODE',
  // 'TRANSCRIPT_CLASSIFIER',
  // 'BASH_CLASSIFIER',
  // 'BUDDY',
  // 'WEB_BROWSER_TOOL',
  // 'AGENT_TRIGGERS',
  // 'ULTRAPLAN',
  // 'MONITOR_TOOL',
  // 'TEAMMEM',
  // 'EXTRACT_MEMORIES',
  // 'MCP_SKILLS',
  // 'REVIEW_ARTIFACT',
  // 'CONNECTOR_TEXT',
  // 'DOWNLOAD_USER_SETTINGS',
  // 'MESSAGE_ACTIONS',
  // 'KAIROS_CHANNELS',
  // 'KAIROS_GITHUB_WEBHOOKS',
]

const moduleSource = `const ENABLED_FEATURES = new Set(${JSON.stringify(enabledFeatures)})

module.exports.feature = function feature(name) {
  return ENABLED_FEATURES.has(name)
}
`

await mkdir(bundleDir, { recursive: true })
await Promise.all([
  writeFile(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: 'bundle', version: '0.0.1', main: 'index.js' }),
    'utf8',
  ),
  writeFile(join(bundleDir, 'index.js'), moduleSource, 'utf8'),
])

console.log(`bun:bundle polyfill installed at ${bundleDir}`)
