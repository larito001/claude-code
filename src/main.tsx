// 运行时宏注入（生产 Bun 构建中的编译时常数）
const runtimeGlobal = globalThis as typeof globalThis & {
  MACRO?: typeof MACRO
}
if (typeof runtimeGlobal.MACRO === 'undefined') {
  runtimeGlobal.MACRO = {
    VERSION: '2.1.87',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '#claude-code-research',
    ISSUES_EXPLAINER: 'https://github.com/larito001/claude-code/issues',
  };
}

// 此副作用必须在所有其他导入之前运行，以便在重模块评估开始前标记条目。
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');
import { feature } from 'src/utils/features.js';
import { Command as CommanderCommand, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import mapValues from 'lodash-es/mapValues.js';
import uniqBy from 'lodash-es/uniqBy.js';
import React from 'react';
import { getSystemContext, getUserContext } from './context.js';
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { addToHistory } from './history.js';
import type { Root } from './ink.js';
import { launchRepl } from './replLauncher.js';
import type { McpSdkServerConfig, McpServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import type { ToolInputJSONSchema } from './Tool.js';
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from './tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { getTools } from './tools.js';
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js';
import { count } from './utils/array.js';
import { installAsciicastRecorder } from './utils/asciicast.js';
import { getCurrentApiCredentialConfigurationError } from './utils/apiCredentialValidation.js';
import { checkHasTrustDialogAccepted, getGlobalConfig, saveGlobalConfig } from './utils/config.js';
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js';
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js';
import { getInitialFastModeSetting, isFastModeEnabled, prefetchFastModeStatus, resolveFastModeStatusFromCache } from './utils/fastMode.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import { createSystemMessage, createUserMessage } from './utils/messages.js';
import { getPlatform } from './utils/platform.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { settingsChangeDetector } from './utils/settings/changeDetector.js';
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js';
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js';
import { computeInitialTeamContext } from './utils/swarm/reconnection.js';
import { initializeWarningHandler } from './utils/warningHandler.js';
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js';

// 惰性 require 避免循环依赖： teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
/** 获取 get Teammate Utils 对应的数据或状态。 */
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js');
/** 获取 get Teammate Prompt Addendum 对应的数据或状态。 */
const getTeammatePromptAddendum = () => require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js');
/** 获取 get Teammate Mode Snapshot 对应的数据或状态。 */
const getTeammateModeSnapshot = () => require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js');
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：COORDINATOR_MODE 的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE') ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { resolve } from 'path';
import { getFeatureValue } from 'src/services/featureConfig.js';
import { getOriginalCwd, setAdditionalDirectoriesForClaudeMd, setMainLoopModelOverride, setMainThreadAgentType } from './bootstrap/state.js';
import { getCommands } from './commands.js';
import type { StatsStore } from './context/stats.js';
import { launchInvalidSettingsDialog, launchResumeChooser } from './dialogLaunchers.js';
import { SHOW_CURSOR } from './ink/termio/dec.js';
import { exitWithError, exitWithMessage, getRenderContext, renderAndRun, showSetupScreens } from './interactiveHelpers.js';
/* eslint-enable @typescript-eslint/no-require-imports */
import { getMcpToolsCommandsAndResources, prefetchAllMcpResources } from './services/mcp/client.js';
import { initBundledSkills } from './skills/bundled/index.js';
import type { AgentColorName } from './tools/AgentTool/agentColorManager.js';
import { getActiveAgentsFromList, getAgentDefinitionsWithOverrides, isBuiltInAgent, isCustomAgent, parseAgentsFromJson } from './tools/AgentTool/loadAgentsDir.js';
import type { LogOption } from './types/logs.js';
import type { Message as MessageType } from './types/message.js';
import { getContextWindowForModel } from './utils/context.js';
import { loadConversationForResume } from './utils/conversationRecovery.js';
import { isBareMode, isEnvTruthy } from './utils/envUtils.js';
import { refreshExampleCommands } from './utils/exampleCommands.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { getWorktreePaths } from './utils/getWorktreePaths.js';
import { getBranch } from './utils/git.js';
import { safeParseJSON } from './utils/json.js';
import { logError } from './utils/log.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, parseUserSpecifiedModel } from './utils/model/model.js';
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js';
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js';
import { checkAndDisableBypassPermissions, getAutoModeEnabledStateIfCached, initializeToolPermissionContext, initialPermissionModeFromCLI, isDefaultPermissionModeAuto, parseToolListFromCLI, stripDangerousPermissionsForAutoMode, verifyAutoModeGateAccess } from './utils/permissions/permissionSetup.js';
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js';
import { cacheSessionTitle, getSessionIdFromLog, loadTranscriptFromFile, saveAgentSetting, saveMode, searchSessionsByCustomTitle, sessionIdExists } from './utils/sessionStorage.js';
import { getInitialSettings, getSettingsWithErrors } from './utils/settings/settings.js';
import { resetSettingsCache } from './utils/settings/settingsCache.js';
import type { ValidationError } from './utils/settings/validation.js';
import { DEFAULT_TASKS_MODE_TASK_LIST_ID } from './utils/tasks.js';
import { generateTempFilePath } from './utils/tempfile.js';
import { validateUuid } from './utils/uuid.js';
// 插件启动检查现在在 REPL.tsx 中以非阻塞方式处理

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js';
import { areMcpConfigsAllowedWithEnterpriseMcpConfig, doesEnterpriseMcpConfigExist, filterMcpServersByPolicy, getClaudeCodeMcpConfigs, parseMcpConfig, parseMcpConfigFromFilePath } from 'src/services/mcp/config.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { registerCleanup } from 'src/utils/cleanupRegistry.js';
import { eagerParseCliFlag } from 'src/utils/cliArgs.js';
import { registerSession, updateSessionName } from 'src/utils/concurrentSessions.js';
import { getCwd } from 'src/utils/cwd.js';
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js';
import { errorMessage, getErrnoCode, isENOENT, toError } from 'src/utils/errors.js';
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js';
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js';
import { peekForStdinData, writeToStderr } from 'src/utils/process.js';
import { setCwd } from 'src/utils/Shell.js';
import { type ProcessedResume, processResumedConversation } from 'src/utils/sessionRestore.js';
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js';
import { plural } from 'src/utils/stringUtils.js';
import { getInitialMainLoopModel, getIsNonInteractiveSession, getSdkBetas, getSessionId, setAllowedSettingSources, setClientType, setCwdState, setFlagSettingsPath, setInitialMainLoopModel, setInlinePlugins, setIsInteractive, setOriginalCwd, setQuestionPreviewFormat, setSdkBetas, setSessionBypassPermissionsMode, setSessionPersistenceDisabled, setSessionSource, switchSession } from './bootstrap/state.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js') : null;

import { initializeLspServerManager } from './services/lsp/manager.js';
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js';
import { type AppState, getDefaultAppState, IDLE_SPECULATION_STATE } from './state/AppStateStore.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { createStore } from './state/store.js';
import { asSessionId } from './types/ids.js';
import { filterAllowedSdkBetas } from './utils/betas.js';
import { isInBundledMode } from './utils/bundledMode.js';
import { logForDiagnosticsNoPII } from './utils/diagLogs.js';
import { filterExistingPaths, getKnownPathsForRepo } from './utils/githubRepoPathMapping.js';
import { clearPluginCache } from './utils/plugins/pluginLoader.js';
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js';
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js';
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from './utils/worktree.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded');

/**
 * 将托管设置密钥记录到 local feature configuration 以进行分析。
 * 这在 init() 完成后调用，以确保加载设置
 * 和环境变量在模型解析之前应用。
 */
/**
 * 仅在安全时才预取系统上下文（包括 git status）。
 * Git 命令可通过钩子和配置执行任意代码（例如 core.fsmonitor，
 * diff.external），因此我们只能在建立信任后或在
 * 信任是隐式的非交互模式。
 */
// ============ 辅助函数：系统上下文预取 / 设置加载 / 入口点初始化 ============
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // 在非交互模式（--print）下，将跳过信任对话框并
  // 执行被认为是可信的（如帮助文本中所述）
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // 在交互模式下，仅在已建立信任的情况下预取
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // 否则，不要预取 - 等待首先建立信任
}

/**
 * 启动首次渲染之前不需要的后台预取和内务处理。
 * 这些是从 setup() 推迟的，以减少事件循环争用和子进程
 * 在关键启动路径期间生成。
 * 在渲染 REPL 后调用此函数。
 */
export function startDeferredPrefetches(): void {
  // 该函数在第一次渲染后运行，因此它不会阻止初始绘制。
  // 然而，生成的进程和异步工作仍然争夺 CPU 和事件
  // 循环时间，这会影响启动基准（CPU 配置文件、首次渲染时间
  // 测量）。当我们只测量启动性能时，请跳过所有这些。
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
  // --bare：跳过所有预取。这些是 REPL 的缓存预热
  // 首轮响应（getUserContext、tips、countFiles、
  // 模型功能、变化检测器）。脚本化 -p 调用没有
  // “用户正在输入”窗口来隐藏这项工作 - 这纯粹是开销
  // 关键路径。
  isBareMode()) {
    return;
  }

  // 进程生成预取（在第一次 API 调用时使用，用户仍在输入）
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  // 后台能力预取
  void refreshModelCapabilities();

  // 文件更改检测器从 init() 推迟到解锁首次渲染
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }

}
/** 获取 load Settings From Flag 对应的数据或状态。 */
function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim();
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}');
    let settingsPath: string;
    if (looksLikeJson) {
      // 这是一个 JSON 字符串 - 验证并创建临时文件
      const parsedJson = safeParseJSON(trimmedSettings);
      if (!parsedJson) {
        process.stderr.write(chalk.red('Error: Invalid JSON provided to --settings\n'));
        process.exit(1);
      }

      // 创建一个临时文件并将 JSON 写入其中。
      // 使用基于内容哈希的路径而不是随机 UUID 来避免
      // 破坏 Anthropic API 提示缓存。设置路径结束
      // 在 Bash 工具的沙箱中的 DenyWithinAllow 列表中，该列表是
      // 发送到 API 的工具描述。每个子进程一个随机的 UUID
      // 更改每个 query() 调用的工具描述，使之无效
      // 缓存前缀并导致 12 倍的输入令牌成本损失。
      // 内容哈希确保相同的设置产生相同的路径
      // 跨进程边界（每个 SDK query() 都会生成一个新进程）。
      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings
      });
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8');
    } else {
      // 这是一个文件路径 - 通过尝试读取来解析和验证
      const {
        resolvedPath: resolvedSettingsPath
      } = safeResolvePath(getFsImplementation(), settingsFile);
      try {
        readFileSync(resolvedSettingsPath, 'utf8');
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`Error: Settings file not found: ${resolvedSettingsPath}\n`));
          process.exit(1);
        }
        throw e;
      }
      settingsPath = resolvedSettingsPath;
    }
    setFlagSettingsPath(settingsPath);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing settings: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}
/** 获取 load Setting Sources From Flag 对应的数据或状态。 */
function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg);
    setAllowedSettingSources(sources);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}

/**
 * 在 init() 前尽早解析并加载设置参数。
 * 这可确保从初始化开始就过滤设置。
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start');
  // 尽早解析 --settings 参数，确保在 init() 前加载设置
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);
  }

  // 尽早解析 --setting-sources 参数，以控制加载哪些来源
  const settingSourcesArg = eagerParseCliFlag('--setting-sources');
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg);
  }
  profileCheckpoint('eagerLoadSettings_end');
}
/** 执行 initialize Entrypoint 对应的业务处理。 */
function initializeEntrypoint(isNonInteractive: boolean): void {
  // 已设置时跳过（例如由 SDK 或其他入口设置）
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return;
  }
  const cliArgs = process.argv.slice(2);

  // 检查 MCP serve 命令（在 mcp serve 前处理参数，例如 --debug mcp serve）
  const mcpIndex = cliArgs.indexOf('mcp');
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp';
    return;
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action';
    return;
  }

  // 注意：local-agent 入口由本地代理模式启动器通过
  // CLAUDE_CODE_ENTRYPOINT 环境变量设置（上方的提前返回会处理它）。

  // 根据是否交互式运行设置。
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}

/** 执行当前模块的主流程。 */
// ============ 程序入口 main()：进程信号处理与交互/非交互模式判定 ============
export async function main() {
  profileCheckpoint('main_function_start');

  // 安全性：阻止 Windows 从当前目录执行命令。
  // 必须在执行任何命令前设置，以防范 PATH 劫持攻击。
  // 参考：https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // 尽早初始化警告处理器以捕获警告
  initializeWarningHandler();
  process.on('exit', () => {
    resetCursor();
  });
  process.on('SIGINT', () => {
    // 在打印模式下，print.ts 会注册自己的 SIGINT 处理器，以中止
    // 正在进行的查询并调用 gracefulShutdown；此处跳过，避免使用
    // 同步的 process.exit() 抢先退出。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return;
    }
    process.exit(0);
  });
  profileCheckpoint('main_warning_handler_initialized');

  // 提前处理深层链接 URI：该路径由操作系统协议处理器调用，
  // 只需解析 URI 并打开终端，因此应在完整初始化前退出。
  // 在 init() 前尽早检查 -p/--print 和 --init-only 参数，以设置 isInteractiveSession。
  // 这是必需的，因为遥测初始化会调用依赖该参数的认证函数。
  const cliArgs = process.argv.slice(2);
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
  const hasInitOnlyFlag = cliArgs.includes('--init-only');
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || !process.stdout.isTTY;

  // 对非交互模式停止捕获早期输入
  if (isNonInteractive) {
    stopCapturingEarlyInput();
  }

  // 设置简化追踪字段
  const isInteractive = !isNonInteractive;
  setIsInteractive(isInteractive);

  // 根据模式初始化入口：必须在记录任何事件前设置
  initializeEntrypoint(isNonInteractive);

  // 确定客户端类型
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') return 'claude-vscode';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return 'local-agent';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude-desktop';

    return 'cli';
  })();
  setClientType(clientType);
  const previewFormat = process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat);
  } else if (!clientType.startsWith('sdk-') &&
  // undefined，不要用 markdown 覆盖它。
  clientType !== 'claude-desktop' && clientType !== 'local-agent') {
    setQuestionPreviewFormat('markdown');
  }

  profileCheckpoint('main_client_type_determined');

  // 在 init() 前尽早解析并加载设置参数
  eagerLoadSettings();
  profileCheckpoint('main_before_run');
  await run();
  profileCheckpoint('main_after_run');
}
/** 获取 get Input Prompt 对应的数据或状态。 */
async function getInputPrompt(prompt: string, inputFormat: 'text' | 'stream-json'): Promise<string | AsyncIterable<string>> {
  if (!process.stdin.isTTY &&
  // 输入劫持会破坏 MCP。
  !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') {
      return process.stdin;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    /** 处理 on Data 对应的数据或状态。 */
    const onData = (chunk: string) => {
      data += chunk;
    };
    process.stdin.on('data', onData);
    // 如果在3秒内没有数据到达，则停止等待并发出警告。stdin很可能是从父进程继承的管道，而父进程并未写入（子进程在没有显式stdin处理的情况下生成）。3秒覆盖了慢速生产者，如curl、处理大文件的jq、带有导入开销的Python。警告使罕见的更慢生产者的静默数据丢失变得可见。
    const timedOut = await peekForStdinData(process.stdin, 3000);
    process.stdin.off('data', onData);
    if (timedOut) {
      process.stderr.write('Warning: no stdin data received in 3s, proceeding without it. ' + 'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n');
    }
    return [prompt, data].filter(Boolean).join('\n');
  }
  return prompt;
}
/** 执行 run 对应的数据或状态。 */
// ============ 核心 run()：构建 Commander 命令并驱动启动流程 ============
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  // 创建按长选项名称排序选项的帮助配置。Commander在运行时支持compareOptions，但@commander-js/extra-typings未在类型定义中包含它，因此我们使用Object.assign来添加它。
  /** 创建 create Sorted Help Config 对应的数据或状态。 */
  function createSortedHelpConfig(): {
    sortSubcommands: true;
    sortOptions: true;
  } {
    /** 获取 get Option Sort Key 对应的数据或状态。 */
    const getOptionSortKey = (opt: Option): string => opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
    return Object.assign({
      sortSubcommands: true,
      sortOptions: true
    } as const, {
      /** 执行 compare Options 对应的业务处理。 */
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b))
    });
  }
  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  // 使用preAction钩子确保仅在执行命令时运行初始化，而不是在显示帮助时。这避免了对环境变量信号的需求。
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start');
    await init();
    profileCheckpoint('preAction_after_init');

    // process.title在Windows上直接设置控制台标题；在POSIX上，终端shell集成可能会将进程名称镜像到标签页。在init()之后，以便settings.json的环境变量也能控制此行为（gh-4765）。
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claude';
    }

    // 为绕过setup()的子命令附加错误接收器。
    const {
      initSinks
    } = await import('./utils/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // Propagate the top-level --plugin-dir option to every command path.
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }
  });
  program.name('claude')
      .description(`Claude Code —— 默认启动交互式会话，使用 -p/--print 以非交互方式输出`)
      .argument('[prompt]', '你的提示词', String)
  // Subcommands inherit helpOption via commander's copyInheritedSettings —
  // setting it once here covers mcp, plugin, auth, and all other subcommands.
  // ---------- 通用启动、生命周期与诊断选项 ----------
  .helpOption('-h, --help', '显示命令帮助')
  .option('-d, --debug [filter]', '启用调试模式，可附带分类过滤（例如 "api,hooks" 或 "!1p,!file"）', (_value: string | true) => {
    // 如果提供了值，它将是过滤字符串；如果未提供但标志存在，值将为true。实际过滤由debug.ts通过解析process.argv处理。
    return true;
  })
  .addOption(new Option('--debug-to-stderr', '启用调试模式（输出到 stderr）').argParser(Boolean).hideHelp())
  .option('--debug-file <path>', '将调试日志写入指定文件路径（隐式启用调试模式）', () => true)
  .option('--verbose', '覆盖配置中的 verbose 模式设置', () => true)
  .option('-p, --print', '打印响应并退出（适合管道使用）。注意：以 -p 模式运行 Claude 时会跳过工作区信任对话框。请仅在可信目录中使用此标志。', () => true)
  .option('--bare', '极简模式：跳过 hooks、LSP、插件同步、自动记忆、后台预取、钥匙串读取以及 CLAUDE.md 自动发现。会设置 CLAUDE_CODE_SIMPLE=1。API 请求使用 ANTHROPIC_API_KEY 或配置的 apiKeyHelper。技能仍可通过 /skill-name 解析。通过以下方式显式提供上下文：--system-prompt[-file]、--append-system-prompt[-file]、--add-dir（CLAUDE.md 目录）、--mcp-config、--settings、--agents、--plugin-dir。', () => true)
  .addOption(new Option('--init', '运行带 init 触发器的 Setup hooks，然后继续').hideHelp())
  .addOption(new Option('--init-only', '运行 Setup 与 SessionStart:startup hooks，然后退出').hideHelp())
  .addOption(new Option('--maintenance', '运行带 maintenance 触发器的 Setup hooks，然后继续').hideHelp())
  // ---------- 非交互输入输出选项 ----------
  .addOption(new Option('--output-format <format>', '输出格式（仅与 --print 配合生效）："text"（默认）、"json"（单个结果）或 "stream-json"（实时流式）').choices(['text', 'json', 'stream-json']))
  .addOption(new Option('--json-schema <schema>', '用于结构化输出校验的 JSON Schema。' + '示例：{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}').argParser(String))
  .option('--include-hook-events', '在输出流中包含全部 hook 生命周期事件（仅与 --output-format=stream-json 配合生效）', () => true)
  .option('--include-partial-messages', '随消息到达包含部分消息分块（仅与 --print 及 --output-format=stream-json 配合生效）', () => true)
  .addOption(new Option('--input-format <format>', '输入格式（仅与 --print 配合生效）："text"（默认）或 "stream-json"（实时流式输入）').choices(['text', 'stream-json']))
  .option('--replay-user-messages', '将来自 stdin 的用户消息重新输出到 stdout 以示确认（仅与 --input-format=stream-json 及 --output-format=stream-json 配合生效）', () => true)
  // ---------- 执行安全与预算限制 ----------
  .option('--dangerously-skip-permissions', '绕过全部权限检查。仅推荐用于无网络访问的沙箱环境。', () => true)
  .option('--allow-dangerously-skip-permissions', '作为可选项启用绕过全部权限检查（默认不启用）。仅推荐用于无网络访问的沙箱环境。', () => true)
  .addOption(new Option('--thinking <mode>', '思考模式：enabled（等效于 adaptive）、disabled').choices(['enabled', 'adaptive', 'disabled']).hideHelp())
  .addOption(new Option('--max-turns <turns>', '非交互模式下的最大自主回合次数。达到指定回合数后将提前结束对话。（仅与 --print 配合生效）').argParser(Number).hideHelp())
  .addOption(new Option('--max-budget-usd <amount>', 'API 调用的最大花费金额（美元）（仅与 --print 配合生效）').argParser(value => {
    const amount = Number(value);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('--max-budget-usd must be a positive number greater than 0');
    }
    return amount;
  }))
  .addOption(new Option('--task-budget <tokens>', 'API 侧的 task budget（以 token 计，即 output_config.task_budget）').argParser(value => {
    const tokens = Number(value);
    if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('--task-budget must be a positive integer');
    }
    return tokens;
  }).hideHelp())
  // ---------- 工具、MCP 与权限选项 ----------
  .option('--allowedTools, --allowed-tools <tools...>', '允许的工具名称列表，以逗号或空格分隔（例如 "Bash(git:*) Edit"）')
  .option('--tools <tools...>', '指定内置可用工具列表。使用 "" 禁用全部工具，使用 "default" 启用全部工具，或直接指定工具名称（例如 "Bash,Edit,Read"）。')
  .option('--disallowedTools, --disallowed-tools <tools...>', '拒绝的工具名称列表，以逗号或空格分隔（例如 "Bash(git:*) Edit"）')
  .option('--mcp-config <configs...>', '从 JSON 文件或字符串加载 MCP 服务器（以空格分隔）')
  .addOption(new Option('--permission-prompt-tool <tool>', '用于权限提示的 MCP 工具（仅与 --print 配合生效）').argParser(String).hideHelp())
  // ---------- 提示词与会话权限模式选项 ----------
  .addOption(new Option('--system-prompt <prompt>', '本次会话使用的系统提示').argParser(String))
  .addOption(new Option('--system-prompt-file <file>', '从文件读取系统提示').argParser(String).hideHelp())
  .addOption(new Option('--append-system-prompt <prompt>', '向默认系统提示追加一段系统提示').argParser(String))
  .addOption(new Option('--append-system-prompt-file <file>', '从文件读取系统提示并追加到默认系统提示').argParser(String).hideHelp())
  .addOption(new Option('--permission-mode <mode>', '本次会话使用的权限模式').argParser(String).choices(PERMISSION_MODES))
  // ---------- 会话创建与恢复选项 ----------
  .option('-c, --continue', '继续当前目录下最近的会话', () => true)
  .option('-r, --resume [value]', '按会话 ID 恢复会话，或打开交互式选择器（可附带搜索词）', value => value || true)
  .option('--fork-session', '恢复时创建新的会话 ID，而非复用原始会话（与 --resume 或 --continue 配合使用）', () => true)
  .addOption(new Option('--prefill <text>', '用文本预填提示输入框，但不提交').hideHelp())
  .option('--from-pr [value]', '按 PR 编号/URL 恢复与 PR 关联的会话，或打开交互式选择器（可附带搜索词）', value => value || true)
  .option('--no-session-persistence', '禁用会话持久化 —— 会话将不会保存到磁盘且无法恢复（仅与 --print 配合生效）')
  .addOption(new Option('--resume-session-at <message id>', '恢复时，仅保留到包含 <message.id> 的助手消息为止（在 print 模式下与 --resume 配合使用）').argParser(String).hideHelp())
  .addOption(new Option('--rewind-files <user-message-id>', '将文件恢复到指定用户消息时的状态并退出（需要 --resume）').hideHelp())
  // ---------- 模型、Agent 与 API 请求选项 ----------
  // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
  .option('--model <model>', `当前会话使用的模型。提供最新模型的别名（例如 'sonnet' 或 'opus'），或模型的完整名称（例如 'claude-sonnet-4-6'）。`)
  .addOption(new Option('--effort <level>', `当前会话的 effort 等级（low、medium、high、max）`).argParser((rawValue: string) => {
    const value = rawValue.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'max'];
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`);
    }
    return value;
  }))
  .option('--agent <agent>', `当前会话使用的 Agent。覆盖 'agent' 设置。`)
  .option('--betas <betas...>', '在 API 请求中包含的 Beta 头（仅限 API key 用户）')
  .option('--fallback-model <model>', '当默认模型过载时，自动回退到指定模型（仅与 --print 配合生效）')
  .addOption(new Option('--workload <tag>', '用于请求分类的 workload 标签。进程级作用域；由启动子进程执行 cron 任务的 SDK daemon 调用方设置。（仅与 --print 配合生效）').hideHelp())
  // ---------- 设置、会话标识、集成与扩展选项 ----------
  .option('--settings <file-or-json>', '用于加载额外设置的 settings JSON 文件路径或 JSON 字符串')
  .option('--add-dir <directories...>', '允许工具访问的额外目录')
  .option('--ide', '若恰好存在一个有效 IDE，则在启动时自动连接', () => true)
  .option('--strict-mcp-config', '仅使用来自 --mcp-config 的 MCP 服务器，忽略所有其他 MCP 配置', () => true)
  .option('--session-id <uuid>', '为会话指定特定的会话 ID（必须是有效的 UUID）')
  .option('-n, --name <name>', '为本会话设置显示名称（显示于 /resume 与终端标题）')
  .option('--agents <json>', '定义自定义 agents 的 JSON 对象（例如 \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\'）')
  .option('--setting-sources <sources>', '以逗号分隔的设置来源列表，用于加载（user, project, local）。')
  // gh-33508: <paths...> (variadic) consumed everything until the next
  // --flag. `claude --plugin-dir /path mcp add --transport http` swallowed
  // `mcp` and `add` as paths, then choked on --transport as an unknown
  // top-level option. Single-value + collect accumulator means each
  // --plugin-dir takes exactly one arg; repeat the flag for multiple dirs.
  .option('--plugin-dir <path>', '仅本会话从目录加载插件（可重复：--plugin-dir A --plugin-dir B）', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--disable-slash-commands', '禁用全部技能', () => true)
  // ============ .action() 主处理器：参数解构 → 校验 → 启动会话 ============
      .action(async (prompt, options) => {
    profileCheckpoint('action_handler_start');

    // --bare = 单开关极简模式。设置SIMPLE以便所有现有门控触发（CLAUDE.md、技能、executeHooks内部的钩子、agent dir-walk）。必须在setup()/任何门控工作运行之前设置。
    if ((options as {
      bare?: boolean;
    }).bare) {
      process.env.CLAUDE_CODE_SIMPLE = '1';
    }

    // 忽略"code"作为提示——将其视为与无提示相同。
    if (prompt === 'code') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.warn(chalk.yellow('Tip: You can launch Claude Code with just `claude`'));
      prompt = undefined;
    }

    const {
      debug = false,
      debugToStderr = false,
      dangerouslySkipPermissions,
      allowDangerouslySkipPermissions = false,
      tools: baseTools = [],
      allowedTools = [],
      disallowedTools = [],
      mcpConfig = [],
      permissionMode: permissionModeCli,
      addDir = [],
      fallbackModel,
      betas = [],
      ide = false,
      sessionId,
      includeHookEvents,
      includePartialMessages
    } = options;
    if (options.prefill) {
      seedEarlyInput(options.prefill);
    }

    // 用于文件下载的Promise——尽早启动，在REPL渲染之前等待。
    const agentsJson = options.agents;
    const agentCli = options.agent;

    // 注意：LSP管理器初始化有意推迟到信任对话框被接受之后。这防止插件LSP服务器在用户同意之前在不信任目录中执行代码。

    // 单独提取这些，以便在需要时可以修改。
    let outputFormat = options.outputFormat;
    let inputFormat = options.inputFormat;
    let verbose = options.verbose ?? getGlobalConfig().verbose;
    let print = options.print;
    const init = options.init ?? false;
    const initOnly = options.initOnly ?? false;
    const maintenance = options.maintenance ?? false;

    // 提取禁用斜杠命令标志。
    const disableSlashCommands = options.disableSlashCommands || false;

    // 用于自动化开发工作流的可选任务列表工作模式。
    const tasksOption = (options as {
      tasks?: boolean | string;
    }).tasks;
    const taskListId = tasksOption ? typeof tasksOption === 'string' ? tasksOption : DEFAULT_TASKS_MODE_TASK_LIST_ID : undefined;
    if (taskListId) {
      process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
    }

    // 提取worktree选项。worktree可以是true（无值的标志）或字符串（自定义名称或PR引用）。
    const worktreeOption = isWorktreeModeEnabled() ? (options as {
      worktree?: boolean | string;
    }).worktree : undefined;
    let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined;
    const worktreeEnabled = worktreeOption !== undefined;

    // 检查worktree名称是否为PR引用（#N或GitHub PR URL）。
    let worktreePRNumber: number | undefined;
    if (worktreeName) {
      const prNum = parsePRReference(worktreeName);
      if (prNum !== null) {
        worktreePRNumber = prNum;
        worktreeName = undefined; // slug将在setup()中生成。
      }
    }

    // 提取tmux选项（需要--worktree）。
    const tmuxEnabled = isWorktreeModeEnabled() && (options as {
      tmux?: boolean;
    }).tmux === true;

    // 验证tmux选项。
    if (tmuxEnabled) {
      if (!worktreeEnabled) {
        process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'));
        process.exit(1);
      }
      if (getPlatform() === 'windows') {
        process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'));
        process.exit(1);
      }
      if (!(await isTmuxAvailable())) {
        process.stderr.write(chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`));
        process.exit(1);
      }
    }

    // 提取teammate选项（用于tmux生成的代理）。在if块外部声明，以便稍后用于系统提示补充。
    let storedTeammateOpts: TeammateOptions | undefined;
    if (isAgentSwarmsEnabled()) {
      // 提取代理身份选项（用于tmux生成的代理）。这些替换CLAUDE_CODE_*环境变量。
      const teammateOpts = extractTeammateOptions(options);
      storedTeammateOpts = teammateOpts;

      // 如果提供了任何teammate身份选项，则必须存在所有三个必需的选项。
      const hasAnyTeammateOpt = teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName;
      const hasAllRequiredTeammateOpts = teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName;
      if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
        process.stderr.write(chalk.red('Error: --agent-id, --agent-name, and --team-name must all be provided together\n'));
        process.exit(1);
      }

      // 如果通过CLI提供了teammate身份，则设置dynamicTeamContext。
      if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
        getTeammateUtils().setDynamicTeamContext?.({
          agentId: teammateOpts.agentId,
          agentName: teammateOpts.agentName,
          teamName: teammateOpts.teamName,
          color: teammateOpts.agentColor,
          planModeRequired: teammateOpts.planModeRequired ?? false,
          parentSessionId: teammateOpts.parentSessionId
        });
      }

      // 如果提供了队友模式CLI覆盖，则设置它。必须在setup()捕获快照之前完成。
      if (teammateOpts.teammateMode) {
        getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode);
      }
    }

    // 允许环境变量启用部分消息（沙箱网关用于baku）。
    const effectiveIncludePartialMessages = includePartialMessages || isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES);

    // 当通过SDK选项明确请求时，启用所有钩子事件类型。否则，仅发出SessionStart和Setup事件。
    if (includeHookEvents) {
      setAllHookEventsEnabled(true);
    }

    if (sessionId) {
      // 检查冲突的标志。当同时提供--fork-session时，--session-id可以与--continue或--resume一起使用（为分叉会话指定自定义ID）。
      if ((options.continue || options.resume) && !options.forkSession) {
        process.stderr.write(chalk.red('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n'));
        process.exit(1);
      }

      const validatedSessionId = validateUuid(sessionId);
      if (!validatedSessionId) {
        process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'));
        process.exit(1);
      }

      // 检查会话ID是否已存在。
      if (sessionIdExists(validatedSessionId)) {
        process.stderr.write(chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`));
        process.exit(1);
      }
    }

    // ---------- 阶段1：凭据 / 模型 / MCP 配置校验 ----------
    // 从状态获取isNonInteractiveSession（在init()之前设置）。
    const isNonInteractiveSession = getIsNonInteractiveSession();

    if (!initOnly) {
      const credentialError = getCurrentApiCredentialConfigurationError();
      if (credentialError) {
        process.stderr.write(chalk.red(`Error: ${credentialError}\n`));
        process.exit(1);
      }
    }

    // 验证备用模型与主模型不同。
    if (fallbackModel && options.model && fallbackModel === options.model) {
      process.stderr.write(chalk.red('Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n'));
      process.exit(1);
    }

    // 处理系统提示选项。
    let systemPrompt = options.systemPrompt;
    if (options.systemPromptFile) {
      if (options.systemPrompt) {
        process.stderr.write(chalk.red('Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.systemPromptFile);
        systemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // 处理附加系统提示选项。
    let appendSystemPrompt = options.appendSystemPrompt;
    if (options.appendSystemPromptFile) {
      if (options.appendSystemPrompt) {
        process.stderr.write(chalk.red('Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.appendSystemPromptFile);
        appendSystemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // 为tmux队友添加特定于队友的系统提示附录。
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName) {
      const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum;
    }
    const {
      mode: permissionMode,
      notification: permissionModeNotification
    } = initialPermissionModeFromCLI({
      permissionModeCli,
      dangerouslySkipPermissions
    });

    // 存储会话绕过权限模式，用于信任对话框检查。
    setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions');
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      // autoModeFlagCli是“用户是否打算为本会话启用自动模式”的信号。设置条件：--enable-auto-mode，--permission-mode auto，已解析模式为auto，或者设置defaultMode为auto但门控拒绝（permissionMode解析为default且没有显式CLI覆盖）。由verifyAutoModeGateAccess用于决定是否在自动不可用时通知，以及由tengu_auto_mode_config选择加入轮播使用。
      if ((options as {
        enableAutoMode?: boolean;
      }).enableAutoMode || permissionModeCli === 'auto' || permissionMode === 'auto' || !permissionModeCli && isDefaultPermissionModeAuto()) {
        autoModeStateModule?.setAutoModeFlagCli(true);
      }
    }

    // 如果提供了MCP配置文件/字符串，则解析它们。
    let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {};
    if (mcpConfig && mcpConfig.length > 0) {
      // 处理mcpConfig数组。
      /** 处理 processed Configs 对应的数据或状态。 */
      const processedConfigs = mcpConfig.map(config => config.trim()).filter(config => config.length > 0);
      let allConfigs: Record<string, McpServerConfig> = {};
      const allErrors: ValidationError[] = [];
      for (const configItem of processedConfigs) {
        let configs: Record<string, McpServerConfig> | null = null;
        let errors: ValidationError[] = [];

        // 首先尝试解析为JSON字符串。
        const parsedJson = safeParseJSON(configItem);
        if (parsedJson) {
          const result = parseMcpConfig({
            configObject: parsedJson,
            filePath: 'command line',
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        } else {
          // 尝试作为文件路径。
          const configPath = resolve(configItem);
          const result = parseMcpConfigFromFilePath({
            filePath: configPath,
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        }
        if (errors.length > 0) {
          allErrors.push(...errors);
        } else if (configs) {
          // 合并配置，后面的覆盖前面的。
          allConfigs = {
            ...allConfigs,
            ...configs
          };
        }
      }
      if (allErrors.length > 0) {
        const formattedErrors = allErrors.map(err => `${err.path ? err.path + ': ' : ''}${err.message}`).join('\n');
        logForDebugging(`--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`, {
          level: 'error'
        });
        process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`);
        process.exit(1);
      }
      if (Object.keys(allConfigs).length > 0) {
        // 为所有配置添加动态作用域。type:'sdk'条目保持不变——它们在下游被提取到sdkMcpConfigs并传递给print.ts。Python SDK依赖此路径（它不在初始化消息中发送sdkMcpServers）。在此处删除它们会破坏Coworker (inc-5122)。下面的策略过滤器已经豁免了type:'sdk'，并且如果没有stdin上的SDK传输，这些条目是惰性的，因此让它们通过没有绕过风险。
        /** 执行 scoped Configs 对应的业务处理。 */
        const scopedConfigs = mapValues(allConfigs, config => ({
          ...config,
          scope: 'dynamic' as const
        }));

        // 对--mcp-config服务器强制执行托管策略（allowedMcpServers / deniedMcpServers）。没有这个，CLI标志会绕过用户/项目/本地配置在getClaudeCodeMcpConfigs中经过的企业允许列表——调用者将dynamicMcpConfig散布在过滤结果之上。在此源头过滤，以便所有下游消费者看到经过策略过滤的集合。
        const {
          allowed,
          blocked
        } = filterMcpServersByPolicy(scopedConfigs);
        if (blocked.length > 0) {
          process.stderr.write(`Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
        }
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...allowed
        };
      }
    }

    // 提取严格的MCP配置标志。
    const strictMcpConfig = options.strictMcpConfig || false;

    // 检查是否存在企业MCP配置。如果存在，只允许包含特殊服务器类型（sdk）的动态MCP配置。
    if (doesEnterpriseMcpConfigExist()) {
      if (strictMcpConfig) {
        process.stderr.write(chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'));
        process.exit(1);
      }

      // 对于--mcp-config，如果所有服务器都是内部类型（sdk），则允许。
      if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
        process.stderr.write(chalk.red('You cannot dynamically configure MCP servers when an enterprise MCP config is present'));
        process.exit(1);
      }
    }

    // 存储用于CLAUDE.md加载的额外目录（由环境变量控制）。
    setAdditionalDirectoriesForClaudeMd(addDir);

    // 此 await 替换了启动路径中已有的阻塞 existsSync/statSync 调用。挂钟时间不变；我们只是在文件系统 I/O 期间让出事件循环而不是阻塞它。参见 #19661。
    const initResult = await initializeToolPermissionContext({
      allowedToolsCli: allowedTools,
      disallowedToolsCli: disallowedTools,
      baseToolsCli: baseTools,
      permissionMode,
      allowDangerouslySkipPermissions,
      addDirs: addDir
    });
    let toolPermissionContext = initResult.toolPermissionContext;
    const {
      warnings,
      dangerousPermissions
    } = initResult;
    if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
      toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext);
    }

    // 打印初始化中的任何警告
    warnings.forEach(warning => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(warning);
    });

    // 尽早启动 MCP 配置加载（安全 - 仅读取文件，不执行）。交互式和 -p 都使用 getClaudeCodeMcpConfigs（仅本地文件读取）。该本地 promise 稍后被等待（在 prefetchAllMcpResources 之前），以使得配置 I/O 与 setup()、命令加载和信任对话框重叠。
    logForDebugging('[STARTUP] Loading MCP configs...');
    const mcpConfigStart = Date.now();
    let mcpConfigResolvedMs: number | undefined;
    // --bare 跳过自动发现的 MCP（.mcp.json、用户设置、插件）——只有显式的 --mcp-config 有效。dynamicMcpConfig 会被展开到下游的 allMcpConfigs 中，因此它能绕过此跳过。
    /** 执行 mcp Config Promise 对应的业务处理。 */
    const mcpConfigPromise = (strictMcpConfig || isBareMode() ? Promise.resolve({
      servers: {} as Record<string, ScopedMcpServerConfig>
    }) : getClaudeCodeMcpConfigs(dynamicMcpConfig)).then(result => {
      mcpConfigResolvedMs = Date.now() - mcpConfigStart;
      return result;
    });

    // 注意：这里我们不调用 prefetchAllMcpResources——它被延迟到信任对话框之后

    if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: Invalid input format "${inputFormat}".`);
      process.exit(1);
    }
    if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: --input-format=stream-json requires output-format=stream-json.`);
      process.exit(1);
    }

    // 验证 replayUserMessages 仅用于 stream-json 格式
    if (options.replayUserMessages) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // 验证 includePartialMessages 仅用于打印模式和 stream-json 输出
    if (effectiveIncludePartialMessages) {
      if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
        writeToStderr(`Error: --include-partial-messages requires --print and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // 验证 --no-session-persistence 仅用于 print 模式
    if (options.sessionPersistence === false && !isNonInteractiveSession) {
      writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`);
      process.exit(1);
    }
    const effectivePrompt = prompt || '';
    let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
    profileCheckpoint('action_after_input_prompt');

    // 在 getTools() 之前激活主动模式，以便 SleepTool.isEnabled()（它返回 isProactiveActive()）通过并且 Sleep 被包含。后续 REPL 路径的 maybeActivateProactive() 调用是幂等的。
    maybeActivateProactive(options);
    let tools = getTools(toolPermissionContext);

    // 对 headless 路径应用协调器模式工具过滤（镜像 REPL/交互路径的 useMergedTools.ts 过滤）
    if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      const {
        applyCoordinatorToolFilter
      } = await import('./utils/toolPool.js');
      tools = applyCoordinatorToolFilter(tools);
    }
    profileCheckpoint('action_tools_loaded');
    let jsonSchema: ToolInputJSONSchema | undefined;
    if (isSyntheticOutputToolEnabled({
      isNonInteractiveSession
    }) && options.jsonSchema) {
      jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema;
    }
    if (jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(jsonSchema);
      if ('tool' in syntheticOutputResult) {
        // 在 getTools() 过滤之后将 SyntheticOutputTool 添加到工具数组中。此工具被排除在常规过滤之外（参见 tools.ts），因为它是结构化输出的实现细节，而不是用户控制的工具。
        tools = [...tools, syntheticOutputResult.tool];
      }
    }

    // ---------- 阶段2：setup() 与命令/agent 并行加载 ----------
    // 重要：setup() 必须在任何依赖于 cwd 或工作树设置的代码之前调用
    profileCheckpoint('action_before_setup');
    logForDebugging('[STARTUP] Running setup()...');
    const setupStart = Date.now();
    const {
      setup
    } = await import('./setup.js');
    // 将 setup() 与命令+代理加载并行化。setup() 的约 28ms 主要是 startUdsMessaging（套接字绑定，约 20ms）——不是磁盘密集型，因此不会与 getCommands 的文件读取竞争。以 !worktreeEnabled 为条件，因为 --worktree 使 setup() 进行 process.chdir()（setup.ts:203），而命令/代理需要 chdir 后的 cwd。
    const preSetupCwd = getCwd();
    // 在启动 getCommands() 之前注册捆绑的技能/插件——它们是纯内存数组推送（<1ms，零 I/O），getBundledSkills() 同步读取它们。先前在 setup() 内部约 20ms 的 await 点之后运行，因此并行的 getCommands() 记忆化了一个空列表。
    if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
      initBundledSkills();
    }
    const setupPromise = setup(preSetupCwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, sessionId ? validateUuid(sessionId) : undefined, worktreePRNumber);
    const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
    const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
    // 如果在 Promise.all 将其合并之前，在约 28ms 的 setupPromise await 期间这些拒绝，则抑制瞬时未处理的 rejection。
    commandsPromise?.catch(() => {});
    agentDefsPromise?.catch(() => {});
    await setupPromise;
    logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`);
    profileCheckpoint('action_after_setup');

    const effectiveReplayUserMessages = !!options.replayUserMessages;
    if (getIsNonInteractiveSession()) {
      // 现在应用完全合并的设置环境（包括项目范围的 .claude-code-core-framework/settings.json PATH/GIT_DIR/GIT_WORK_TREE），以便 gitExe() 和下面的 git spawn 能够看到它们。信任在 -p 模式下是隐式的；managedEnv.ts:96-97 的文档字符串说明这应用来自所有来源的“潜在危险的环境变量如 LD_PRELOAD、PATH”。下面的 isNonInteractiveSession 块中的后续调用是幂等的（Object.assign，configureGlobalAgents 弹出之前的拦截器），并在插件初始化后获取任何插件贡献的环境。项目设置已经在这里加载：init() 中的 applySafeConfigEnvironmentVariables 调用了 managedEnv.ts:86 的 getInitialSettings，它合并了所有启用的来源，包括 projectSettings/localSettings。
      applyConfigEnvironmentVariables();

      // 现在生成 git status/log/branch，以便子进程执行与下面的 getCommands await 和 startDeferredPrefetches 重叠。在 setup() 之后，以便 cwd 是最终的（setup.ts:254 可能对 --worktree 执行 process.chdir(worktreePath)），并且在上述 applyConfigEnvironmentVariables 之后，以便来自所有来源（受信任 + 项目）的 PATH/GIT_DIR/GIT_WORK_TREE 被应用。getSystemContext 被记忆化；startDeferredPrefetches 中的 prefetchSystemContextIfSafe 调用变为缓存命中。await getIsGit() 产生的微任务在下面的 getCommands Promise.all await 中耗尽。信任在 -p 模式下是隐式的（与 prefetchSystemContextIfSafe 相同的条件）。
      void getSystemContext();
      // 现在也启动 getUserContext——其第一个 await（getMemoryFiles 中的 fs.readFile）自然让步，因此 CLAUDE.md 目录遍历在 print.ts 中上下文 Promise.all 合并之前约 280ms 的重叠窗口期间运行。startDeferredPrefetches 中的 void getUserContext() 变为记忆化缓存命中。
      void getUserContext();
      // 在读取模型选项前完成模型字符串初始化。
      void ensureModelStringsInitialized();
    }

    // 应用 --name: cache-only，因此在会话 ID 由 --continue/--resume 最终确定之前不会创建孤立文件。materializeSessionFile 在第一条用户消息时持久化它；REPL 的 useTerminalTitle 通过 getCurrentSessionTitle 读取它。
    const sessionNameArg = options.name?.trim();
    if (sessionNameArg) {
      cacheSessionTitle(sessionNameArg);
    }

    // 使用 null 关键字对默认模型进行特殊处理。模型解析发生在 setup() 之后。
    const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model;
    const userSpecifiedFallbackModel = fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel;

    // 重用 preSetupCwd，除非 setup() 执行了 chdir（worktreeEnabled）。在常见路径中节省了一次 getCwd() 系统调用。
    const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd;
    logForDebugging('[STARTUP] Loading commands and agents...');
    const commandsStart = Date.now();
    // 合并 setup() 之前触发的 promise（如果 worktreeEnabled 提前触发了，则重新开始）。两者均按 cwd 缓存。
    const [commands, agentDefinitionsResult] = await Promise.all([commandsPromise ?? getCommands(currentCwd), agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd)]);
    logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`);
    profileCheckpoint('action_commands_loaded');

    // 如果通过 --agents 标志提供，则解析 CLI agents
    let cliAgents: typeof agentDefinitionsResult.activeAgents = [];
    if (agentsJson) {
      try {
        const parsedAgents = safeParseJSON(agentsJson);
        if (parsedAgents) {
          cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings');
        }
      } catch (error) {
        logError(error);
      }
    }

    // 将 CLI agents 与已有的 agents 合并
    const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents];
    const agentDefinitions = {
      ...agentDefinitionsResult,
      allAgents,
      activeAgents: getActiveAgentsFromList(allAgents)
    };

    // 从 CLI 标志或设置中查找主线程 agent
    const agentSetting = agentCli ?? getInitialSettings().agent;
    let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined;
    if (agentSetting) {
      mainThreadAgentDefinition = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting);
      if (!mainThreadAgentDefinition) {
        logForDebugging(`Warning: agent "${agentSetting}" not found. ` + `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` + `Using default behavior.`);
      }
    }

    // 将主线程 agent 类型存储到 bootstrap state 中，以便 hooks 可以访问
    setMainThreadAgentType(mainThreadAgentDefinition?.agentType);

    // 将 agent 设置持久化到会话转录中，用于 resume 视图显示和恢复
    if (mainThreadAgentDefinition?.agentType) {
      saveAgentSetting(mainThreadAgentDefinition.agentType);
    }

    // 对非交互式会话应用 agent 的系统提示（交互模式改用 buildEffectiveSystemPrompt）
    if (isNonInteractiveSession && mainThreadAgentDefinition && !systemPrompt && !isBuiltInAgent(mainThreadAgentDefinition)) {
      const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt();
      if (agentSystemPrompt) {
        systemPrompt = agentSystemPrompt;
      }
    }

    // initialPrompt 放在前面，以便其斜杠命令（如果有）先被处理；用户提供的文本成为后续上下文。仅在 inputPrompt 是字符串时拼接。当它为 AsyncIterable（SDK stream-json 模式）时，模板插值会调用 .toString() 产生 "[object Object]"。AsyncIterable 的情况在 print.ts 中通过 structuredIO.prependUserMessage() 处理。
    if (mainThreadAgentDefinition?.initialPrompt) {
      if (typeof inputPrompt === 'string') {
        inputPrompt = inputPrompt ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}` : mainThreadAgentDefinition.initialPrompt;
      } else if (!inputPrompt) {
        inputPrompt = mainThreadAgentDefinition.initialPrompt;
      }
    }

    // ---------- 阶段3：模型 / agent / 系统提示拼装 ----------
    // 尽早计算有效模型，以便 hooks 可以与 MCP 并行运行。如果用户未指定模型但 agent 有模型，则使用 agent 的模型
    let effectiveModel = userSpecifiedModel;
    if (!effectiveModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
      effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model);
    }
    setMainLoopModelOverride(effectiveModel);

    // 计算用于 hooks 的最终模型（使用启动时用户指定的模型）
    setInitialMainLoopModel(getUserSpecifiedModelSetting() || null);
    const initialMainLoopModel = getInitialMainLoopModel();
    const resolvedInitialModel = parseUserSpecifiedModel(initialMainLoopModel ?? getDefaultMainLoopModel());
    // 对于使用 --agent-type 的 tmux teammates，追加自定义 agent 的提示
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName && storedTeammateOpts?.agentType) {
      // 查找自定义 agent 定义
      /** 执行 custom Agent 对应的业务处理。 */
      const customAgent = agentDefinitions.activeAgents.find(a => a.agentType === storedTeammateOpts.agentType);
      if (customAgent) {
        // 获取提示 - 需要同时处理内置和自定义 agent
        let customPrompt: string | undefined;
        if (customAgent.source === 'built-in') {
          // 内置 agent 有接受 toolUseContext 的 getSystemPrompt。我们在这里无法访问完整的 toolUseContext，因此暂时跳过
          logForDebugging(`[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`);
        } else {
          // 自定义 agent 有 getSystemPrompt，不接收参数
          customPrompt = customAgent.getSystemPrompt();
        }

        if (customPrompt) {
          const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
          appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
        }
      } else {
        logForDebugging(`[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`);
      }
    }
    // Coordinator 模式有自己的系统提示，并过滤掉 Sleep，因此通用主动提示会告诉它调用一个无法访问的工具，并与委托指令冲突。
    if ((feature('PROACTIVE')) && ((options as {
      proactive?: boolean;
    }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) && !coordinatorModeModule?.isCoordinatorMode()) {
      const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. The user will see any text you output.`;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt;
    }
    // ---------- 阶段4：交互式 setup 界面与信任后初始化 ----------
    // 仅交互式会话需要 Ink root——Ink 构造函数中的 patchConsole 会在无头模式下吞掉 console 输出。
    let root!: Root;
    let getFpsMetrics!: () => FpsMetrics | undefined;
    let stats!: StatsStore;

    // 在命令加载后显示设置界面
    if (!isNonInteractiveSession) {
      const ctx = getRenderContext(false);
      getFpsMetrics = ctx.getFpsMetrics;
      stats = ctx.stats;
      // 选择加入终端录制，用于诊断和集成测试。
      installAsciicastRecorder();
      const {
        createRoot
      } = await import('./ink.js');
      root = await createRoot(ctx.renderOptions);

      // 现在记录启动时间，在任何阻塞对话框渲染之前。从 REPL 首次渲染（旧位置）记录日志包含了用户停留在信任/OAuth/引导/恢复选择器上的时间——p99 约为 70 秒，主要由等待对话框的时间主导，而不是代码路径启动时间。
      logForDebugging('[STARTUP] Running showSetupScreens()...');
      const setupScreensStart = Date.now();
      await showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions);
      logForDebugging(`[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`);

    }

    // 如果 gracefulShutdown 已启动（例如，用户拒绝了信任对话框），process.exitCode 将被设置。跳过所有可能在进程退出前触发代码执行的后续操作（例如，如果信任未建立，我们不希望 apiKeyHelper 运行）。
    if (process.exitCode !== undefined) {
      logForDebugging('Graceful shutdown initiated, skipping further initialization');
      return;
    }

    // 在信任建立之后（或在非交互式模式下，信任是隐式的）初始化 LSP 管理器。这防止插件 LSP 服务器在用户同意前在不受信任的目录中执行代码。必须在内联插件（如果有）之后设置，以便包含 --plugin-dir LSP 服务器。
    initializeLspServerManager();

    // 在信任建立后显示设置验证错误。MCP 配置错误不会阻止设置加载，因此排除它们
    if (!isNonInteractiveSession) {
      const {
        errors
      } = getSettingsWithErrors();
      /** 执行 non Mcp Errors 对应的业务处理。 */
      const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata);
      if (nonMcpErrors.length > 0) {
        await launchInvalidSettingsDialog(root, {
          settingsErrors: nonMcpErrors,
          /** 处理 on Exit 对应的数据或状态。 */
          onExit: () => gracefulShutdownSync(1)
        });
      }
    }

    // 在信任建立后预热提供者无关的运行时能力。这些进行 API 调用，可能触发 apiKeyHelper 执行。--bare / SIMPLE：跳过——这些是为了 REPL 首次响应速度的缓存预热。快速模式无论如何不适用于 Agent SDK（见 getFastModeUnavailableReason）。
    const bgRefreshThrottleMs = getFeatureValue('tengu_cicada_nap_ms', 0);
    const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0;
    const skipStartupPrefetches = isBareMode() || bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs;
    if (!skipStartupPrefetches) {
      const lastPrefetchedInfo = lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : '';
      logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`);
      if (!getFeatureValue('tengu_miraculo_the_bard', false)) {
        void prefetchFastModeStatus();
      } else {
        // 终止开关跳过网络调用，但不跳过组织策略执行。
        // 从缓存中解析以使 orgStatus 不会保持 'pending' 状态（
        // getFastModeUnavailableReason 认为 pending 状态是允许的）。
        resolveFastModeStatusFromCache();
      }
      if (bgRefreshThrottleMs > 0) {
        saveGlobalConfig(current => ({
          ...current,
          startupPrefetchedAt: Date.now()
        }));
      }
    } else {
      logForDebugging(`Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`);
      // 从缓存中解析快速模式组织状态（无网络请求）
      resolveFastModeStatusFromCache();
    }
    if (!isNonInteractiveSession) {
      void refreshExampleCommands(); // 预取示例命令（执行 git log，无 API 调用）
    }

    // ---------- 阶段5：MCP 配置解析与会话启动钩子派发 ----------
    // 解析 MCP 配置（提前启动，与设置/信任对话框工作重叠）
    const {
      servers: existingMcpConfigs
    } = await mcpConfigPromise;
    logForDebugging(`[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`);
    // CLI 标志（--mcp-config）应覆盖基于文件的配置，匹配设置的优先级
    const allMcpConfigs = {
      ...existingMcpConfigs,
      ...dynamicMcpConfig
    };

    // 将 SDK 配置与常规 MCP 配置分开
    const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {};
    const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {};
    for (const [name, config] of Object.entries(allMcpConfigs)) {
      const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig;
      if (typedConfig.type === 'sdk') {
        sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig;
      } else {
        regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig;
      }
    }
    profileCheckpoint('action_mcp_configs_loaded');

    // 在信任对话框后预取 MCP 资源（这是执行发生的地方）。
    // 仅交互模式：print 模式延迟连接，直到 headlessStore 存在
    // 并逐个推送服务器（如下），以便连接状态可以及时更新。
    // 并且一个慢速服务器不会阻塞整个批处理。
    const mcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : prefetchAllMcpResources(regularMcpConfigs);

    // 尽早启动钩子，使其与 MCP 连接并行运行。
    // 对于 initOnly/init/maintenance（单独处理）、非交互模式（通过 setupTrigger 处理）
    // 和 resume/continue（conversationRecovery.ts 触发 'resume' 代替——如果没有此守卫，钩子会在 /resume 上触发两次
    // 且第二个 systemMessage 会覆盖第一个。gh-30825）跳过。
    const hooksPromise = initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume ? null : processSessionStartHooks('startup', {
      agentType: mainThreadAgentDefinition?.agentType,
      model: resolvedInitialModel
    });

    // MCP 从不阻塞 REPL 渲染或第一轮 TTFT。useManageMCPConnections
    // 异步填充 appState.mcp，因为服务器连接（connectToServer 已被记忆化——上面的预取调用和钩子收敛于相同连接）。getToolUseContext 通过 computeTools() 从 store.getState() 读取最新值，因此第一轮能看到查询时已连接的内容。
    // 慢速服务器为第二轮及之后填充。匹配交互式无提示行为。
    // Print 模式：逐个推送到 headlessStore（如下）。
    const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = [];
    // 抑制瞬时的 unhandledRejection——预取会预热记忆化的 connectToServer 缓存，但在交互模式中无人等待它。
    mcpPromise.catch(() => {});
    const mcpClients: Awaited<typeof mcpPromise>['clients'] = [];
    const mcpTools: Awaited<typeof mcpPromise>['tools'] = [];
    const mcpCommands: Awaited<typeof mcpPromise>['commands'] = [];
    let thinkingEnabled = shouldEnableThinkingByDefault();
    let thinkingConfig: ThinkingConfig = thinkingEnabled !== false ? {
      type: 'adaptive'
    } : {
      type: 'disabled'
    };
    if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
      thinkingEnabled = true;
      thinkingConfig = {
        type: 'adaptive'
      };
    } else if (options.thinking === 'disabled') {
      thinkingEnabled = false;
      thinkingConfig = {
        type: 'disabled'
      };
    }
    logForDiagnosticsNoPII('info', 'started', {
      version: MACRO.VERSION,
      is_native_binary: isInBundledMode()
    });
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'exited');
    });
    // 为并发会话检测（~/.claude-code-core-framework/sessions/）注册 PID 文件
    // 用于交互路径。放在这里（而不是 init.ts）以便只有 REPL 路径注册——
    // 而不是像 `claude doctor` 这样的子命令。链式：
    // 计数必须在注册写入完成后运行，否则会错过我们自己的文件。
    void registerSession().then(registered => {
      if (!registered) return;
      if (sessionNameArg) {
        void updateSessionName(sessionNameArg);
      }
    });

    // 初始化版本化插件系统（如果需要，触发 V1→V2 迁移）。
    // 然后运行孤儿 GC，再预热 Grep/Glob 排除缓存。
    // 顺序很重要：预热会扫描磁盘上的 .orphaned_at 标记，
    // 因此它必须看到 GC 的通过 1（从重新安装的版本中移除标记）和通过 2（标记未标记的孤儿）已经应用。
    // 预热也在后台插件更新（在 REPL 中首次提交时触发）
    // 可能孤立当前会话的活动插件版本之前完成。
    // --bare / SIMPLE：跳过插件版本同步 + 孤儿清理。这些
    // 是安装/升级记账操作，脚本调用不需要——
    const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
    // ---------- 阶段6：--init-only 早退路径 ----------
    if (initOnly) {
      applyConfigEnvironmentVariables();
      await processSetupHooks('init', {
        forceSyncExecution: true
      });
      await processSessionStartHooks('startup', {
        forceSyncExecution: true
      });
      gracefulShutdownSync(0);
      return;
    }

    // ---------- 阶段7：--print 无头模式（runHeadless） ----------
    // --print 模式
    if (isNonInteractiveSession) {
      if (outputFormat === 'stream-json' || outputFormat === 'json') {
        setHasFormattedOutput(true);
      }

      // 在 print 模式下应用完整的环境变量，因为跳过了信任对话框
      // 这包括来自不受信任源的潜在危险环境变量
      // 但 print 模式被认为是受信任的（如帮助文本中所述）
      applyConfigEnvironmentVariables();

      // 在环境变量应用后初始化遥测，以便 OTEL 端点环境变量和
      // otelHeadersHelper（需要信任才能执行）可用。
      initializeTelemetryAfterTrust();

      // 现在启动 SessionStart 钩子，以便子进程生成与
      // MCP 连接 + 插件初始化 + 下面的 print.ts 导入重叠。loadInitialMessages
      // 在 print.ts:4397 处加入此过程。与 loadInitialMessages 相同的守卫——
      // 条件性地在 resume 分支内部，其中此 promise 为 undefined 且 ?? 后备运行。
      // 当设置了 setupTrigger 时也跳过——这些路径首先运行设置钩子（print.ts:544），
      // 并且会话启动钩子必须等待设置完成。
      const sessionStartHooksPromise = options.continue || options.resume || setupTrigger ? undefined : processSessionStartHooks('startup');
      // 如果此 promise 在 loadInitialMessages 等待它之前拒绝，则抑制瞬时的 unhandledRejection。下游的 await 仍然会观察到拒绝——这只是防止虚假的全局处理程序触发。
      sessionStartHooksPromise?.catch(() => {});
      // 无头模式支持所有提示命令和一些本地命令
      // 如果 disableSlashCommands 为 true，则返回空数组
      const commandsHeadless = disableSlashCommands ? [] : commands.filter(command => command.type === 'prompt' && !command.disableNonInteractive || command.type === 'local' && command.supportsNonInteractive);
      const defaultState = getDefaultAppState();
      const headlessInitialState: AppState = {
        ...defaultState,
        mcp: {
          ...defaultState.mcp,
          clients: mcpClients,
          commands: mcpCommands,
          tools: mcpTools
        },
        toolPermissionContext,
        effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        ...(isFastModeEnabled() && {
          fastMode: getInitialFastModeSetting(effectiveModel ?? null)
        }),
      };

      // 初始化应用状态
      const headlessStore = createStore(headlessInitialState, onChangeAppState);

      // 检查是否应根据本地功能配置门禁禁用 bypassPermissions
      // 这与下面的代码并行运行，以避免阻塞主循环。
      if (toolPermissionContext.mode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
        void checkAndDisableBypassPermissions(toolPermissionContext);
      }

      // 异步检查自动模式门禁——更正状态并在必要时禁用自动模式。
      // 基于 TRANSCRIPT_CLASSIFIER 进行门控，使其保持本地可配置。
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        void verifyAutoModeGateAccess(toolPermissionContext, headlessStore.getState().fastMode).then(({
          updateContext
        }) => {
          headlessStore.setState(prev => {
            const nextCtx = updateContext(prev.toolPermissionContext);
            if (nextCtx === prev.toolPermissionContext) return prev;
            return {
              ...prev,
              toolPermissionContext: nextCtx
            };
          });
        });
      }

      // 设置用于会话持久化的全局状态
      if (options.sessionPersistence === false) {
        setSessionPersistenceDisabled(true);
      }

      // 在全局状态中存储SDK测试版，用于上下文窗口计算
      // 仅存储允许的SDK测试版标头。
      setSdkBetas(filterAllowedSdkBetas(betas));

      // 打印模式MCP：每个服务器增量推送到headlessStore。
      // 镜像 useManageMCPConnections——先推送待处理项，
      // 然后在每个服务器稳定时替换为已连接/已失败状态。
      /** 执行 connect Mcp Batch 对应的业务处理。 */
      const connectMcpBatch = (configs: Record<string, ScopedMcpServerConfig>, label: string): Promise<void> => {
        if (Object.keys(configs).length === 0) return Promise.resolve();
        headlessStore.setState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: [...prev.mcp.clients, ...Object.entries(configs).map(([name, config]) => ({
              name,
              type: 'pending' as const,
              config
            }))]
          }
        }));
        return getMcpToolsCommandsAndResources(({
          client,
          tools,
          commands
        }) => {
          headlessStore.setState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.some(c => c.name === client.name) ? prev.mcp.clients.map(c => c.name === client.name ? client : c) : [...prev.mcp.clients, client],
              tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
              commands: uniqBy([...prev.mcp.commands, ...commands], 'name')
            }
          }));
        }, configs).catch(err => logForDebugging(`[MCP] ${label} connect error: ${err}`));
      };
      // 等待所有MCP配置——打印模式通常是单轮对话，因此
      // “下一轮可见的延迟连接服务器”没有帮助。SDK初始化
      // 消息和第一轮工具列表都需要已配置的MCP工具存在。
      // 零服务器情况通过connectMcpBatch中的提前返回来实现。
      // 连接器在getMcpToolsCommandsAndResources内部并行化。
      profileCheckpoint('before_connectMcp');
      await connectMcpBatch(regularMcpConfigs, 'regular');
      profileCheckpoint('after_connectMcp');
      // 在无头模式下，立即启动延迟预取（无用户输入延迟）
      // --bare / SIMPLE: startDeferredPrefetches内部提前返回。
      // 后台维护（initExtractMemories、pruneShellSnapshots、
      // cleanupOldMessageFiles）是脚本调用不需要的簿记操作——
      // 下一个交互式会话会进行协调。
      if (!isBareMode()) {
        startDeferredPrefetches();
        void import('./utils/backgroundHousekeeping.js').then(m => m.startBackgroundHousekeeping());
      }
      profileCheckpoint('before_print_import');
      const {
        runHeadless
      } = await import('src/cli/print.js');
      profileCheckpoint('after_print_import');
      void runHeadless(inputPrompt, () => headlessStore.getState(), headlessStore.setState, commandsHeadless, tools, sdkMcpConfigs, agentDefinitions.activeAgents, {
        continue: options.continue,
        resume: options.resume,
        verbose: verbose,
        outputFormat: outputFormat,
        jsonSchema,
        permissionPromptToolName: options.permissionPromptTool,
        allowedTools,
        thinkingConfig,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        taskBudget: options.taskBudget ? {
          total: options.taskBudget
        } : undefined,
        systemPrompt,
        appendSystemPrompt,
        userSpecifiedModel: effectiveModel,
        fallbackModel: userSpecifiedFallbackModel,
        replayUserMessages: effectiveReplayUserMessages,
        includePartialMessages: effectiveIncludePartialMessages,
        forkSession: options.forkSession || false,
        resumeSessionAt: options.resumeSessionAt || undefined,
        rewindFiles: options.rewindFiles,
        agent: agentCli,
        workload: options.workload,
        setupTrigger: setupTrigger ?? undefined,
        sessionStartHooksPromise
      });
      return;
    }

    // 启动时记录模型配置

    // 构建初始通知队列
    const initialNotifications: Array<{
      key: string;
      text: string;
      color?: 'warning';
      priority: 'high';
    }> = [];
    if (permissionModeNotification) {
      initialNotifications.push({
        key: 'permission-mode-notification',
        text: permissionModeNotification,
        priority: 'high'
      });
    }
    const effectiveToolPermissionContext = {
      ...toolPermissionContext,
      mode: isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired() ? 'plan' as const : toolPermissionContext.mode
    };
    // ---------- 阶段8：交互式 initialState 构建 ----------
    const initialState: AppState = {
      settings: getInitialSettings(),
      tasks: {},
      agentNameRegistry: new Map(),
      verbose: verbose ?? getGlobalConfig().verbose ?? false,
      mainLoopModel: initialMainLoopModel,
      mainLoopModelForSession: null,
      expandedView: getGlobalConfig().showSpinnerTree ? 'teammates' : getGlobalConfig().showExpandedTodos ? 'tasks' : 'none',
      showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
      selectedIPAgentIndex: -1,
      coordinatorTaskIndex: -1,
      viewSelectionMode: 'none',
      footerSelection: null,
      toolPermissionContext: effectiveToolPermissionContext,
      agent: mainThreadAgentDefinition?.agentType,
      agentDefinitions,
      mcp: {
        clients: [],
        tools: [],
        commands: [],
        resources: {},
        pluginReconnectKey: 0
      },
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
      },
      statusLineText: undefined,

      notifications: {
        current: null,
        queue: initialNotifications
      },
      elicitation: {
        queue: []
      },
      fileHistory: {
        snapshots: [],
        trackedFiles: new Set(),
        snapshotSequence: 0
      },
      thinkingEnabled,
      promptSuggestionEnabled: shouldEnablePromptSuggestion(),
      sessionHooks: new Map(),
      inbox: {
        messages: []
      },
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      },
      speculation: IDLE_SPECULATION_STATE,
      speculationSessionTimeSavedMs: 0,
      workerSandboxPermissions: {
        queue: [],
        selectedIndex: 0
      },
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      initialMessage: inputPrompt ? {
        message: createUserMessage({
          content: String(inputPrompt)
        })
      } : null,
      effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
      activeOverlays: new Set<string>(),
      fastMode: getInitialFastModeSetting(resolvedInitialModel),
      // 同步计算teamContext以避免渲染期间调用useEffect setState。
      teamContext: computeInitialTeamContext?.()
    };

    // 将CLI初始提示添加到历史记录
    if (inputPrompt) {
      addToHistory(String(inputPrompt));
    }
    const initialTools = mcpTools;

    // 在首次渲染前同步递增numStartups。
    saveGlobalConfig(current => ({
      ...current,
      numStartups: (current.numStartups ?? 0) + 1
    }));

    const sessionConfig = {
      debug: debug || debugToStderr,
      commands: [...commands, ...mcpCommands],
      initialTools,
      mcpClients,
      autoConnectIdeFlag: ide,
      mainThreadAgentDefinition,
      disableSlashCommands,
      dynamicMcpConfig,
      strictMcpConfig,
      systemPrompt,
      appendSystemPrompt,
      taskListId,
      thinkingConfig
    };

    // processResumedConversation调用共享的上下文
    const resumeContext = {
      modeApi: coordinatorModeModule,
      mainThreadAgentDefinition,
      agentDefinitions,
      currentCwd,
      cliAgents,
      initialState
    };
    // ---------- 阶段9：会话恢复/续接（--continue / --resume） ----------
    if (options.continue) {
      // 直接继续最近的对话
      try {
        const resumeStart = performance.now();

        // 恢复前清除陈旧缓存，确保新的文件/技能发现
        const {
          clearSessionCaches
        } = await import('./commands/clear/caches.js');
        clearSessionCaches();
        const result = await loadConversationForResume(undefined /* 会话 ID */, undefined /* 源文件 */);
        if (!result) {
          return await exitWithError(root, 'No conversation found to continue');
        }
        const loaded = await processResumedConversation(result, {
          forkSession: !!options.forkSession,
          transcriptPath: result.fullPath
        }, resumeContext);
        if (loaded.restoredAgentDef) {
          mainThreadAgentDefinition = loaded.restoredAgentDef;
        }
        maybeActivateProactive(options);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: loaded.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: loaded.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: loaded.messages,
          initialFileHistorySnapshots: loaded.fileHistorySnapshots,
          initialContentReplacements: loaded.contentReplacements,
          initialAgentName: loaded.agentName,
          initialAgentColor: loaded.agentColor
        }, renderAndRun);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    } else if (options.resume || options.fromPr) {
      // 处理恢复流程——来自转录文件、会话ID或交互式选择器

      // 恢复前清除陈旧缓存，确保新的文件/技能发现
      const {
        clearSessionCaches
      } = await import('./commands/clear/caches.js');
      clearSessionCaches();
      let messages: MessageType[] | null = null;
      let processedResume: ProcessedResume | undefined = undefined;
      let maybeSessionId = validateUuid(options.resume);
      let searchTerm: string | undefined = undefined;
      // 当通过自定义标题找到时，存储完整的LogOption（用于跨工作树恢复）
      let matchedLog: LogOption | null = null;
      // 针对--from-pr标志的PR过滤器
      let filterByPr: boolean | number | string | undefined = undefined;

      // 处理--from-pr标志
      if (options.fromPr) {
        if (options.fromPr === true) {
          // 显示所有关联PR的会话
          filterByPr = true;
        } else if (typeof options.fromPr === 'string') {
          // 可能是PR编号或URL
          filterByPr = options.fromPr;
        }
      }

      // 如果恢复值不是UUID，先通过自定义标题尝试精确匹配
      if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
        const trimmedValue = options.resume.trim();
        if (trimmedValue) {
          const matches = await searchSessionsByCustomTitle(trimmedValue, {
            exact: true
          });
          if (matches.length === 1) {
            // 找到精确匹配 - 存储完整的LogOption用于跨工作树恢复
            matchedLog = matches[0]!;
            maybeSessionId = getSessionIdFromLog(matchedLog) ?? null;
          } else {
            // 无匹配或多项匹配 — 用作选择器的搜索词
            searchTerm = trimmedValue;
          }
        }
      }

      if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
        const resolvedPath = resolve(options.resume);
        try {
          const resumeStart = performance.now();
          let logOption;
          try {
            logOption = await loadTranscriptFromFile(resolvedPath);
          } catch (error) {
            if (!isENOENT(error)) throw error;
          }
          if (logOption) {
            const result = await loadConversationForResume(logOption, undefined);
            if (result) {
              processedResume = await processResumedConversation(result, {
                forkSession: !!options.forkSession,
                transcriptPath: result.fullPath
              }, resumeContext);
              if (processedResume.restoredAgentDef) {
                mainThreadAgentDefinition = processedResume.restoredAgentDef;
              }
            }
          }
        } catch (error) {
          logError(error);
          await exitWithError(root, `Unable to load transcript from file: ${options.resume}`, () => gracefulShutdown(1));
        }
      }

      // 如果未作为文件加载，则尝试作为会话ID
      if (maybeSessionId) {
        // 按ID恢复指定会话
        const sessionId = maybeSessionId;
        try {
          const resumeStart = performance.now();
          // 如果可用，使用matchedLog（用于按自定义标题跨工作树恢复）
          // 否则回退到sessionId字符串（用于直接UUID恢复）
          const result = await loadConversationForResume(matchedLog ?? sessionId, undefined);
          if (!result) {
            return await exitWithError(root, `No conversation found with session ID: ${sessionId}`);
          }
          const fullPath = matchedLog?.fullPath ?? result.fullPath;
          processedResume = await processResumedConversation(result, {
            forkSession: !!options.forkSession,
            sessionIdOverride: sessionId,
            transcriptPath: fullPath
          }, resumeContext);
          if (processedResume.restoredAgentDef) {
            mainThreadAgentDefinition = processedResume.restoredAgentDef;
          }
        } catch (error) {
          logError(error);
          await exitWithError(root, `Failed to resume session ${sessionId}`);
        }
      }

      const resumeData = processedResume ?? (Array.isArray(messages) ? {
        messages,
        fileHistorySnapshots: undefined,
        agentName: undefined,
        agentColor: undefined as AgentColorName | undefined,
        restoredAgentDef: mainThreadAgentDefinition,
        initialState,
        contentReplacements: undefined
      } : undefined);
      if (resumeData) {
        maybeActivateProactive(options);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: resumeData.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: resumeData.messages,
          initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
          initialContentReplacements: resumeData.contentReplacements,
          initialAgentName: resumeData.agentName,
          initialAgentColor: resumeData.agentColor
        }, renderAndRun);
      } else {
        // 显示交互式选择器（包括同一仓库的工作树）
        // 注意：ResumeConversation内部加载日志以确保选择后正确的GC
        await launchResumeChooser(root, {
          getFpsMetrics,
          stats,
          initialState
        }, getWorktreePaths(getOriginalCwd()), {
          ...sessionConfig,
          initialSearchQuery: searchTerm,
          forkSession: options.forkSession,
          filterByPr
        });
      }
    } else {
      // 将未解析的hooks promise传递给REPL，使其能立即渲染，
      // 而不是阻塞约500毫秒等待SessionStart钩子完成。
      // REPL将在钩子解析时注入钩子消息，并在首次API调用前等待它们，
      // 以便模型始终看到钩子上下文。
      const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined;
      profileCheckpoint('action_after_hooks');
      maybeActivateProactive(options);
      // 持久化当前模式用于新会话，以便将来恢复时知道使用了什么模式
      if (feature('COORDINATOR_MODE')) {
        saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // 如果通过深度链接启动，显示来源横幅，让用户知道会话来自外部。
      // Linux的xdg-open和设置了“始终允许”的浏览器在分发链接时没有操作系统级别的确认，
      // 因此这是用户能得到的唯一信号，表明提示——以及它所隐含的工作目录/CLAUDE.md——
      // 来自外部源而非用户自己输入。
      const initialMessages = hookMessages.length > 0 ? hookMessages : undefined;
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        ...sessionConfig,
        initialMessages,
        pendingHookMessages
      }, renderAndRun);
    }
  // ============ 版本号、额外选项与子命令注册 ============
  }).version(`${MACRO.VERSION} (Claude Code)`, '-v, --version', 'Output the version number');

  // ---------- 工作树、自动化与实验性选项 ----------
  program.option('-w, --worktree [name]', 'Create a new git worktree for this session (optionally specify a name)');
  program.option('--tmux', 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.');
  program.addOption(new Option('--tasks [id]', 'Watch a task list and automatically process available tasks.').argParser(String));
  program.option('--agent-teams', 'Enable multi-agent mode for this session', () => true);
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }
  if (feature('PROACTIVE')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }
  // ---------- 多 Agent 队友选项 ----------
  // 队友身份选项（由leader在生成tmux队友时设置）
  // 这些会替换CLAUDE_CODE_*环境变量
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp());
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp());
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp());
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp());
  program.addOption(new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp());
  program.addOption(new Option('--parent-session-id <id>', 'Parent session ID for agent coordination').hideHelp());
  program.addOption(new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"').choices(['auto', 'tmux', 'in-process']).hideHelp());
  program.addOption(new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp());
  // ---------- 调试容错选项 ----------
  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp());
  }
  profileCheckpoint('run_main_options_built');

  // ---------- print 模式：提前 parse 并 return ----------
  // -p/--print模式跳过子命令注册，因为Commander直接将提示路由到默认动作。
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  if (isPrintMode) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // ---------- 注册子命令：mcp / plugin / agents / auto-mode / doctor ----------
  // MCP 子命令

  const mcp = program.command('mcp').description('配置与管理 MCP 服务器').configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  mcp.command('serve').description(`启动 Claude Code MCP 服务器`).option('-d, --debug', '启用调试模式', () => true).option('--verbose', '覆盖配置中的 verbose 模式设置', () => true).action(async ({
    debug,
    verbose
  }: {
    debug?: boolean;
    verbose?: boolean;
  }) => {
    const {
      mcpServeHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpServeHandler({
      debug,
      verbose
    });
  });

  // 注册mcp add子命令（提取以便测试）
  registerMcpAddCommand(mcp);
  mcp.command('remove <name>').description('移除一个 MCP 服务器').option('-s, --scope <scope>', '配置作用域（local, user, or project）—— 若未指定，则从它所在的任意作用域中移除').action(async (name: string, options: {
    scope?: string;
  }) => {
    const {
      mcpRemoveHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpRemoveHandler(name, options);
  });
  mcp.command('list').description('列出已配置的 MCP 服务器。注意：将跳过工作区信任对话框，并会启动来自 .mcp.json 的 stdio 服务器进行健康检查。请仅在可信目录中使用此命令。').action(async () => {
    const {
      mcpListHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpListHandler();
  });
  mcp.command('get <name>').description('获取某个 MCP 服务器的详细信息。注意：将跳过工作区信任对话框，并会启动来自 .mcp.json 的 stdio 服务器进行健康检查。请仅在可信目录中使用此命令。').action(async (name: string) => {
    const {
      mcpGetHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpGetHandler(name);
  });
  mcp.command('add-json <name> <json>').description('通过 JSON 字符串添加一个 MCP 服务器（stdio 或 SSE）').option('-s, --scope <scope>', '配置作用域（local, user, or project）', 'local').option('--client-secret', '提示输入 OAuth 客户端密钥（或设置 MCP_CLIENT_SECRET 环境变量）').action(async (name: string, json: string, options: {
    scope?: string;
    clientSecret?: true;
  }) => {
    const {
      mcpAddJsonHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddJsonHandler(name, json, options);
  });
  mcp.command('reset-project-choices').description('重置本项目内所有已批准和已拒绝的项目级（.mcp.json）服务器').action(async () => {
    const {
      mcpResetChoicesHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpResetChoicesHandler();
  });

  // 插件验证命令
  const pluginCmd = program.command('plugin').alias('plugins').description('校验本地插件').configureHelp(createSortedHelpConfig());
  pluginCmd.command('validate <path>').description('校验本地插件目录或 plugin.json').action(async (manifestPath: string) => {
    const {
      pluginValidateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginValidateHandler(manifestPath);
  });

  // Agents命令 — 列出已配置的agents
  program.command('agents').description('列出已配置的 agents').option('--setting-sources <sources>', '以逗号分隔的设置来源列表，用于加载（user, project, local）。').action(async () => {
    const {
      agentsHandler
    } = await import('./cli/handlers/agents.js');
    await agentsHandler();
    process.exit(0);
  });
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 当tengu_auto_mode_config.enabled === 'disabled'时跳过（断路器）。
    // 从磁盘缓存读取 — 注册时本地功能配置未初始化。
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program.command('auto-mode').description('检查 auto mode 分类器配置');
      autoModeCmd.command('defaults').description('以 JSON 形式打印默认 auto mode 环境、allow 与 deny 规则').action(async () => {
        const {
          autoModeDefaultsHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeDefaultsHandler();
        process.exit(0);
      });
      autoModeCmd.command('config').description('以 JSON 形式打印生效的 auto mode 配置：已设置的采用你的设置，否则采用默认值').action(async () => {
        const {
          autoModeConfigHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeConfigHandler();
        process.exit(0);
      });
      autoModeCmd.command('critique').description('获取 AI 对你自定义 auto mode 规则的反馈').option('--model <model>', '覆盖所使用的模型').action(async options => {
        const {
          autoModeCritiqueHandler
        } = await import('./cli/handlers/autoMode.js');
        await autoModeCritiqueHandler(options);
        process.exit();
      });
    }
  }

  program.command('doctor').description('Check runtime, settings, tools, plugins, and MCP health. The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks, so only use this command in directories you trust.').action(async () => {
    const [{
      doctorHandler
    }, {
      createRoot
    }] = await Promise.all([import('./cli/handlers/util.js'), import('./ink.js')]);
    const root = await createRoot(getBaseRenderOptions(false));
    await doctorHandler(root);
  });

  // ---------- 默认模式：统一 parse 并收尾 ----------
  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // 记录最终检查点用于total_time计算
  profileCheckpoint('main_after_run');

  // 将启动性能记录到本地功能配置（抽样）并在启用时输出详细报告
  profileReport();
  return program;
}
/** 执行 maybe Activate Proactive 对应的业务处理。 */
// ============ 尾部辅助函数 ============
function maybeActivateProactive(options: unknown): void {
  if ((feature('PROACTIVE')) && ((options as {
    proactive?: boolean;
  }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js');
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command');
    }
  }
}
/** 重置或恢复 reset Cursor 对应的数据或状态。 */
function resetCursor() {
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined;
  terminal?.write(SHOW_CURSOR);
}
type TeammateOptions = {
  agentId?: string;
  agentName?: string;
  teamName?: string;
  agentColor?: string;
  planModeRequired?: boolean;
  parentSessionId?: string;
  teammateMode?: 'auto' | 'tmux' | 'in-process';
  agentType?: string;
};
/** 执行 extract Teammate Options 对应的业务处理。 */
function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {};
  }
  const opts = options as Record<string, unknown>;
  const teammateMode = opts.teammateMode;
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired: typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode: teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process' ? teammateMode : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined
  };
}
