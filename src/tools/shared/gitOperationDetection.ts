function gitCommandPattern(subcommand: string, suffix = ''): RegExp {
  return new RegExp(
    `\\bgit(?:\\s+-[cC]\\s+\\S+|\\s+--\\S+=\\S+)*\\s+${subcommand}\\b${suffix}`,
  )
}

const GIT_COMMIT_RE = gitCommandPattern('commit')
const GIT_PUSH_RE = gitCommandPattern('push')
const GIT_CHERRY_PICK_RE = gitCommandPattern('cherry-pick')
const GIT_MERGE_RE = gitCommandPattern('merge', '(?!-)')
const GIT_REBASE_RE = gitCommandPattern('rebase')

export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
export type BranchAction = 'merged' | 'rebased'
export type PrAction =
  | 'created'
  | 'edited'
  | 'merged'
  | 'commented'
  | 'closed'
  | 'ready'

const PR_ACTIONS: readonly { pattern: RegExp; action: PrAction }[] = [
  { pattern: /\bgh\s+pr\s+create\b/, action: 'created' },
  { pattern: /\bgh\s+pr\s+edit\b/, action: 'edited' },
  { pattern: /\bgh\s+pr\s+merge\b/, action: 'merged' },
  { pattern: /\bgh\s+pr\s+comment\b/, action: 'commented' },
  { pattern: /\bgh\s+pr\s+close\b/, action: 'closed' },
  { pattern: /\bgh\s+pr\s+ready\b/, action: 'ready' },
]

function parseCommitId(output: string): string | undefined {
  return output.match(/\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]+)\]/)?.[1]
}

function parsePushBranch(output: string): string | undefined {
  return output.match(
    /^\s*[+\-*!= ]?\s*(?:\[new branch\]|\S+\.\.\S+)\s+\S+\s*->\s*(\S+)/m,
  )?.[1]
}

function parseRef(command: string, verb: string): string | undefined {
  const remainder = command.split(gitCommandPattern(verb))[1]
  if (!remainder) return undefined
  for (const token of remainder.trim().split(/\s+/)) {
    if (/^[&|;><]/.test(token)) break
    if (!token.startsWith('-')) return token
  }
  return undefined
}

function parsePullRequest(output: string): { number: number; url?: string } | null {
  const url = output.match(
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/,
  )?.[0]
  if (url) {
    const number = Number(url.match(/\/pull\/(\d+)/)?.[1])
    if (number) return { number, url }
  }
  const number = Number(output.match(/[Pp]ull request (?:\S+#)?#?(\d+)/)?.[1])
  return number ? { number } : null
}

/** Detect operations for the local collapsed command summary. */
export function detectGitOperation(
  command: string,
  output: string,
): {
  commit?: { sha: string; kind: CommitKind }
  push?: { branch: string }
  branch?: { ref: string; action: BranchAction }
  pr?: { number: number; url?: string; action: PrAction }
} {
  const result: ReturnType<typeof detectGitOperation> = {}
  const cherryPick = GIT_CHERRY_PICK_RE.test(command)
  if (GIT_COMMIT_RE.test(command) || cherryPick) {
    const sha = parseCommitId(output)
    if (sha) {
      result.commit = {
        sha: sha.slice(0, 6),
        kind: cherryPick
          ? 'cherry-picked'
          : /--amend\b/.test(command)
            ? 'amended'
            : 'committed',
      }
    }
  }
  if (GIT_PUSH_RE.test(command)) {
    const branch = parsePushBranch(output)
    if (branch) result.push = { branch }
  }
  if (GIT_MERGE_RE.test(command) && /(Fast-forward|Merge made by)/.test(output)) {
    const ref = parseRef(command, 'merge')
    if (ref) result.branch = { ref, action: 'merged' }
  }
  if (GIT_REBASE_RE.test(command) && /Successfully rebased/.test(output)) {
    const ref = parseRef(command, 'rebase')
    if (ref) result.branch = { ref, action: 'rebased' }
  }
  const action = PR_ACTIONS.find(item => item.pattern.test(command))?.action
  if (action) {
    const pullRequest = parsePullRequest(output)
    if (pullRequest) result.pr = { ...pullRequest, action }
  }
  return result
}
