import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getAutoMemDailyLogPath } from '../../memdir/paths.js'
import { logForDebugging } from '../../utils/debug.js'

type TranscriptMessage = {
  type: string
  uuid?: string
  timestamp?: string | number
  message?: { content?: unknown }
}

const writtenMessageIds = new Set<string>()
let writeQueue: Promise<void> = Promise.resolve()

function getMessageDate(message: TranscriptMessage): Date {
  if (message.timestamp !== undefined) {
    const parsed = new Date(message.timestamp)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (!block || typeof block !== 'object') return []
      const value = block as { type?: string; text?: unknown }
      return value.type === 'text' && typeof value.text === 'string'
        ? [value.text.trim()]
        : []
    })
    .filter(Boolean)
    .join('\n')
}

function renderMessage(message: TranscriptMessage): string | null {
  if (message.type !== 'user' && message.type !== 'assistant') return null
  const text = extractText(message.message?.content)
  if (!text) return null
  const role = message.type === 'user' ? 'User' : 'Assistant'
  return `### ${role}\n\n${text}\n`
}

async function appendMessages(messages: readonly TranscriptMessage[]): Promise<void> {
  const byFile = new Map<string, { ids: string[]; sections: string[] }>()

  messages.forEach((message, index) => {
    const rendered = renderMessage(message)
    if (!rendered) return
    const id = message.uuid ?? `${message.type}:${index}:${rendered}`
    if (writtenMessageIds.has(id)) return

    const path = getAutoMemDailyLogPath(getMessageDate(message))
    const bucket = byFile.get(path) ?? { ids: [], sections: [] }
    bucket.ids.push(id)
    bucket.sections.push(rendered)
    byFile.set(path, bucket)
  })

  for (const [path, bucket] of byFile) {
    await mkdir(dirname(path), { recursive: true })
    const header = `\n## Session transcript ${new Date().toISOString()}\n\n`
    await appendFile(path, header + bucket.sections.join('\n'), 'utf8')
    bucket.ids.forEach(id => writtenMessageIds.add(id))
  }
}

export function writeSessionTranscriptSegment(
  messages: readonly TranscriptMessage[],
): Promise<void> {
  writeQueue = writeQueue
    .then(() => appendMessages(messages))
    .catch(error => {
      logForDebugging(
        `Failed to write session transcript segment: ${String(error)}`,
        { level: 'error' },
      )
    })
  return writeQueue
}
