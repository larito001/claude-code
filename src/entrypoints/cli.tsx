import { feature } from 'bun:bundle';

// 修复 corepack 自动固定版本的问题，该功能会把 yarnpkg 添加到用户的 package.json 中
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// DeepSeek exposes an Anthropic-compatible API, so the SDK still reads its
// conventional variable internally. The user-facing development config keeps
// the provider-specific name and takes precedence over inherited shell values.
if (process.env.DEEPSEEK_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.DEEPSEEK_API_KEY;
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late. feature() gate
// DCEs this entire block from external builds.
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * 引导入口：加载完整 CLI 前先检查特殊参数。
 * 所有导入均为动态导入，以尽量减少快速路径中的模块求值。
 * --version 快速路径除本文件外不会导入任何模块。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --version/-v 快速路径：无需加载任何模块
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION is inlined in release builds. Source-mode `bun run dev`
    // reaches this fast path before main.tsx installs the runtime fallback.
    const version = typeof MACRO !== 'undefined' ? MACRO.VERSION : '2.1.87';
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${version} (Claude Code)`);
    return;
  }

  // 其他路径需要加载启动性能分析器
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // --dump-system-prompt 快速路径：输出渲染后的系统提示词并退出。
  // 提示词敏感性评测用它提取特定提交中的系统提示词。
  // 仅供内部使用：外部构建会通过功能开关移除此逻辑。
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] || getMainLoopModel();
    const {
      getSystemPrompt
    } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const {
      runClaudeInChromeMcpServer
    } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // Fast-path for `--daemon-worker=<kind>` (internal — supervisor spawns this).
  // Must come before the daemon subcommand check: spawned per-worker, so
  // perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
  // workers are lean. If a worker kind needs configs/auth (assistant will),
  // it calls them inside its run() fn.
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // Fast-path for `claude daemon [subcommand]`: long-running supervisor.
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // Fast-path for `claude ps|logs|attach|kill` and `--bg`/`--background`.
  // Session management against the ~/.claude/sessions/ registry. Flag
  // literals are inlined so bg.js only loads when actually dispatching.
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        await bg.killHandler(args[1]);
        break;
      default:
        await bg.handleBgFlag(args);
    }
    return;
  }

  // Fast-path for template job commands.
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // process.exit (not return) — mountFleetView's Ink TUI can leave event
    // loop handles that prevent natural exit.
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // Fast-path for `claude environment-runner`: headless BYOC runner.
  // feature() must stay inline for build-time dead code elimination.
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for `claude self-hosted-runner`: headless self-hosted-runner
  // targeting the SelfHostedRunnerWorkerService API (register + poll; poll IS
  // heartbeat). feature() must stay inline for build-time dead code elimination.
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for --worktree --tmux: exec into tmux before loading full CLI
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // If not handled (e.g., error), fall through to normal CLI
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: set SIMPLE early so gates fire during module eval / commander
  // option building (not just inside the action handler).
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // 未检测到特殊参数，加载并运行完整 CLI
  const {
    startCapturingEarlyInput
  } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const {
    main: cliMain
  } = await import('../main.js');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();
