import { feature } from 'src/utils/features.js';

// 修复 corepack 自动固定版本的问题，该功能会把 yarnpkg 添加到用户的 package.json 中
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// DeepSeek exposes an Anthropic-compatible API, so the SDK still reads its
// conventional variable internally. The user-facing development config keeps
// the provider-specific name and takes precedence over inherited shell values.
if (process.env.DEEPSEEK_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.DEEPSEEK_API_KEY;
}

// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late. Keep this before
// the dynamic CLI import so explicit harness settings take effect.
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
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
