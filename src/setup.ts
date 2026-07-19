/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'src/utils/features.js'
import chalk from 'chalk'
import { getCwd } from 'src/utils/cwd.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

/** 设置并保存 setup 对应的数据或状态。 */
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // 检查Node.js版本是否低于18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      chalk.bold.red(
        'Error: Claude Code requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  // 如果提供了自定义会话ID，则设置它
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // 队友快照 — 仅SIMPLE门（无逃生舱，裸模式下不使用群组）
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // 终端备份恢复 — 仅交互模式。打印模式不与终端设置交互；下一个交互会话将检测并恢复任何中断的设置。
  if (!getIsNonInteractiveSession()) {
    // 仅在启用群组时进行iTerm2备份检查
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
          ),
        )
      }
    }

    // 检查并在设置中断时恢复 Terminal.app 备份
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
          ),
        )
      }
    } catch (error) {
      // 若 Terminal.app 备份恢复失败则记录日志但不崩溃
      logError(error)
    }
  }

  // 重要：必须在任何依赖 cwd 的代码之前调用 setCwd()
  setCwd(cwd)

  // 捕获钩子配置快照以避免隐藏的钩子修改。
  // 重要：必须在 setCwd() 之后调用，以便从正确的目录加载钩子
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // 初始化 FileChanged 钩子监视器 — 同步，读取钩子配置快照
  initializeFileChangedWatcher(cwd)

  // 处理工作树创建（如果请求）
  // 重要：必须在 getCommands() 之前调用，否则 /eject 将不可用。
  if (worktreeEnabled) {
    // 镜像 bridgeMain.ts：配置了钩子的会话可以无需 git 进行，因此 createWorktreeForSession() 可以委托给钩子（非 git VCS）。
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
            `Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
        ),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // Git 前导码在任何 git 仓库中都会运行——即使配置了钩子——因此 --tmux 对于也拥有 WorktreeCreate 钩子的 git 用户仍然有效。仅钩子模式（非 git）会跳过它。
    let tmuxSessionName: string | undefined
    if (inGit) {
      // 解析到主仓库根目录（处理从工作树内部调用的情况）。
      // findCanonicalGitRoot 是同步/仅文件系统/记忆化的；底层的 findGitRoot 缓存已被上面的 getIsGit() 预热，因此这几乎是免费的。
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `Error: Could not determine the main git repository root.\n`,
          ),
        )
        process.exit(1)
      }

      // 如果在工作树内部，则切换到主仓库进行工作树创建
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // 非 git 钩子模式：没有要解析的规范根目录，因此从 cwd 命名 tmux 会话——generateTmuxSessionName 仅对路径取基名。
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }


    // 如果启用，为工作树创建 tmux 会话
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.green(
            `Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.yellow(
            `Warning: Failed to create tmux session: ${tmuxResult.error}`,
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree 意味着工作树就是会话的项目，因此技能/钩子/cron 等应在此处解析。（EnterWorktreeTool 在会话中不会触及 projectRoot——那是临时工作树，项目保持稳定。）
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // 清除内存文件缓存，因为 originalCwd 已更改
    clearMemoryFileCaches()
    // 设置缓存已在 init() 中（通过 applySafeConfigEnvironmentVariables）以及上面的 captureHooksConfigSnapshot() 中填充，两者都是从原始目录的 .claude-code-core-framework/settings.json 读取。从工作树重新读取并重新捕获钩子。
    updateHooksConfigSnapshot()
  }

  // 后台任务——仅需在第一次查询前完成的关键注册
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // 内置技能/插件在 main.tsx 中并行 getCommands() 启动前注册——请参见那里的注释。移出 setup() 是因为上面的等待点（startUdsMessaging，约20毫秒）导致 getCommands() 抢先执行并记忆了一个空的 builtinSkills 列表。
  if (!isBareMode()) {
    initSessionMemory() // 同步——注册钩子，门控检查惰性执行
  }
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  // 预取 Promise——仅渲染前需要的项
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // Prefetch explicitly configured local plugins unless bare mode disables them.
  const skipPluginPrefetch = isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // 预加载插件钩子（在渲染前由 processSessionStartHooks 消费）
    }
  })
  initSinks()

  prefetchApiKeyFromApiKeyHelperIfSafe() // 安全预取——仅在信任已确认时执行
  profileCheckpoint('setup_after_prefetch')

  if (!isBareMode()) {
    await getRecentActivity()
  }
  // 如果权限模式设置为绕过，请验证我们处于安全环境中
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // 检查是否在类Unix系统上以root/sudo运行
    // 如果在沙箱中（例如需要root的TPU开发空间），则允许root
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

}
