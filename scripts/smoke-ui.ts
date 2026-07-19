import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const tempConfig = await mkdtemp(join(tmpdir(), 'claude-ui-smoke-'))
const previousConfigDir = process.env.FRAMEWORK_CONFIG_DIR
process.env.FRAMEWORK_CONFIG_DIR = tempConfig

try {
  const { clearBundledSkills } = await import('../src/skills/bundledSkills.js')
  const { initBundledSkills } = await import('../src/skills/bundled/index.js')
  const { getCommands } = await import('../src/commands.js')
  const { ColorDiff, ColorFile } = await import(
    '../src/native-ts/color-diff/index.js'
  )

  clearBundledSkills()
  initBundledSkills()
  const commands = await getCommands(tempConfig)
  for (const commandName of ['help', 'permissions', 'mcp', 'tasks', 'exit']) {
    const command = commands.find(candidate => candidate.name === commandName)
    assert(command, `Runtime command is missing: /${commandName}`)
    assert(
      command.type === 'local-jsx',
      `Runtime command has the wrong type: /${commandName}`,
    )
    const commandModule = await command.load()
    assert(
      typeof commandModule.call === 'function',
      `Runtime command module did not export call(): /${commandName}`,
    )
  }

  const highlighted = new ColorFile(
    'const smoke = 42\nconsole.log(smoke)\n',
    'smoke.ts',
  ).render('dark', 80, false)
  assert(highlighted?.length === 2, 'Syntax-highlighted file did not render')
  assert(
    highlighted.join('\n').includes('smoke'),
    'Syntax highlighting lost source content',
  )

  const narrow = new ColorFile('界', 'smoke.ts').render('dark', 1, true)
  assert(narrow?.length === 1, 'Narrow syntax rendering failed to terminate')
  assert(
    new ColorFile('', 'smoke.ts').render('dark', 80, false)?.length === 0,
    'Empty syntax rendering returned unexpected rows',
  )

  const diff = new ColorDiff(
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-const smoke = 1', '+const smoke = 2'],
    },
    null,
    'smoke.ts',
  ).render('dark', 24, false)
  assert(diff?.length === 2, 'Structured diff did not render')
} finally {
  if (previousConfigDir === undefined) delete process.env.FRAMEWORK_CONFIG_DIR
  else process.env.FRAMEWORK_CONFIG_DIR = previousConfigDir
  await rm(tempConfig, { recursive: true, force: true })
}

console.log('UI and command smoke: ok')
