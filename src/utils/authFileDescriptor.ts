import { mkdirSync, writeFileSync } from 'fs'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * Well-known token file locations in CCR. The Go environment-manager creates
 * /home/claude/.claude/remote/ and will (eventually) write these files too.
 * Until then, this module writes them on successful FD read so subprocesses
 * spawned inside the CCR container can find the token without inheriting
 * the FD — which they can't: pipe FDs don't cross tmux/shell boundaries.
 */
const CCR_TOKEN_DIR = '/home/claude/.claude/remote'
export const CCR_SESSION_INGRESS_TOKEN_PATH = `${CCR_TOKEN_DIR}/.session_ingress_token`

/**
 * Best-effort write of the token to a well-known location for subprocess
 * access. CCR-gated: outside CCR there's no /home/claude/ and no reason to
 * put a token on disk that the FD was meant to keep off disk.
 */
export function maybePersistTokenForSubprocesses(
  path: string,
  token: string,
  tokenName: string,
): void {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    return
  }
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- one-shot startup write in CCR, caller is sync
    mkdirSync(CCR_TOKEN_DIR, { recursive: true, mode: 0o700 })
    // eslint-disable-next-line custom-rules/no-sync-fs -- one-shot startup write in CCR, caller is sync
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 })
    logForDebugging(`Persisted ${tokenName} to ${path} for subprocess access`)
  } catch (error) {
    logForDebugging(
      `Failed to persist ${tokenName} to disk (non-fatal): ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * Fallback read from a well-known file. The path only exists in CCR (env-manager
 * creates the directory), so file-not-found is the expected outcome everywhere
 * else — treated as "no fallback", not an error.
 */
export function readTokenFromWellKnownFile(
  path: string,
  tokenName: string,
): string | null {
  try {
    const fsOps = getFsImplementation()
    // eslint-disable-next-line custom-rules/no-sync-fs -- fallback read for CCR subprocess path, one-shot at startup, caller is sync
    const token = fsOps.readFileSync(path, { encoding: 'utf8' }).trim()
    if (!token) {
      return null
    }
    logForDebugging(`Read ${tokenName} from well-known file ${path}`)
    return token
  } catch (error) {
    // ENOENT is the expected outcome outside CCR — stay silent. Anything
    // else (EACCES from perm misconfig, etc.) is worth surfacing in the
    // debug log so subprocess auth failures aren't mysterious.
    if (!isENOENT(error)) {
      logForDebugging(
        `Failed to read ${tokenName} from ${path}: ${errorMessage(error)}`,
        { level: 'debug' },
      )
    }
    return null
  }
}

/**
 * Shared FD-or-well-known-file credential reader.
 *
 * Priority order:
 *  1. File descriptor (legacy path) — env var points at a pipe FD passed by
 *     the Go env-manager via cmd.ExtraFiles. Pipe is drained on first read
 *     and doesn't cross exec/tmux boundaries.
 *  2. Well-known file — written by this function on successful FD read (and
 *     eventually by the env-manager directly). Covers subprocesses that can't
 *     inherit the FD.
 *
 * Returns null if neither source has a credential. Cached in global state.
 */
