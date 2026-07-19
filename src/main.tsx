// 运行时宏注入（生产 Bun 构建中的编译时常数）
const runtimeGlobal = globalThis as typeof globalThis & {
  MACRO?: typeof MACRO
}
if (typeof runtimeGlobal.MACRO === 'undefined') {
  runtimeGlobal.MACRO = {
    VERSION: '2.1.87',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '#claude-code-research',
    ISSUES_EXPLAINER: 'https://github.com/beita6969/claude-code/issues',
  };
}

// 这些副作用必须在所有其他导入之前运行：
// 1. profileCheckpoint 在重模块评估开始之前标记条目
// 2. startMdmRawRead 触发 MDM 子进程（plutil/reg 查询），以便它们在
//    与下面剩余的约 135 毫秒的导入并行
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead();
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
import { prefetchOfficialMcpUrls } from './services/mcp/officialRegistry.js';
import type { McpSdkServerConfig, McpServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import type { ToolInputJSONSchema } from './Tool.js';
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from './tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { getTools } from './tools.js';
import { canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, isValidAdvisorModel, modelSupportsAdvisor } from './utils/advisor.js';
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js';
import { count } from './utils/array.js';
import { installAsciicastRecorder } from './utils/asciicast.js';
import { prefetchAwsCredentialsAndBedRockInfoIfSafe, prefetchGcpCredentialsIfSafe } from './utils/auth.js';
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
import { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES } from './services/plugins/pluginCliCommands.js';
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
import { getModelDeprecationWarning } from './utils/model/deprecation.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, normalizeModelStringForAPI, parseUserSpecifiedModel } from './utils/model/model.js';
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js';
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js';
import { checkAndDisableBypassPermissions, getAutoModeEnabledStateIfCached, initializeToolPermissionContext, initialPermissionModeFromCLI, isDefaultPermissionModeAuto, parseToolListFromCLI, stripDangerousPermissionsForAutoMode, verifyAutoModeGateAccess } from './utils/permissions/permissionSetup.js';
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js';
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js';
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js';
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js';
import { cacheSessionTitle, getSessionIdFromLog, loadTranscriptFromFile, saveAgentSetting, saveMode, searchSessionsByCustomTitle, sessionIdExists } from './utils/sessionStorage.js';
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js';
import { getInitialSettings, getSettingsWithErrors } from './utils/settings/settings.js';
import { resetSettingsCache } from './utils/settings/settingsCache.js';
import type { ValidationError } from './utils/settings/validation.js';
import { DEFAULT_TASKS_MODE_TASK_LIST_ID } from './utils/tasks.js';
import { generateTempFilePath } from './utils/tempfile.js';
import { validateUuid } from './utils/uuid.js';
// 插件启动检查现在在 REPL.tsx 中以非阻塞方式处理

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js';
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js';
import { areMcpConfigsAllowedWithEnterpriseMcpConfig, doesEnterpriseMcpConfigExist, filterMcpServersByPolicy, getClaudeCodeMcpConfigs, parseMcpConfig, parseMcpConfigFromFilePath } from 'src/services/mcp/config.js';
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { registerCleanup } from 'src/utils/cleanupRegistry.js';
import { eagerParseCliFlag } from 'src/utils/cliArgs.js';
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js';
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
import { type ChannelEntry, getInitialMainLoopModel, getIsNonInteractiveSession, getSdkBetas, getSessionId, setAllowedChannels, setAllowedSettingSources, setClientType, setCwdState, setFlagSettingsPath, setInitialMainLoopModel, setInlinePlugins, setIsInteractive, setOriginalCwd, setQuestionPreviewFormat, setSdkBetas, setSessionBypassPermissionsMode, setSessionPersistenceDisabled, setSessionSource, switchSession } from './bootstrap/state.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js') : null;

import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateLegacyOpusToCurrent } from './migrations/migrateLegacyOpusToCurrent.js';
import { migrateOpusToOpus1m } from './migrations/migrateOpusToOpus1m.js';
import { migrateSonnet1mToSonnet45 } from './migrations/migrateSonnet1mToSonnet45.js';
import { resetAutoModeOptInForDefaultOffer } from './migrations/resetAutoModeOptInForDefaultOffer.js';
/* eslint-enable @typescript-eslint/no-require-imports */
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
// @[MODEL LAUNCH]：考虑模型字符串可能需要的任何迁移。有关示例，请参阅 migrateSonnet1mToSonnet45.ts。
// 添加新的同步迁移时请更改此设置，以便现有用户重新运行该集。
const CURRENT_MIGRATION_VERSION = 11;
/** 执行 run Migrations 对应的数据或状态。 */
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateOpusToOpus1m();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev : {
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    });
  }
}

/**
 * 仅在安全时才预取系统上下文（包括 git status）。
 * Git 命令可通过钩子和配置执行任意代码（例如 core.fsmonitor，
 * diff.external），因此我们只能在建立信任后或在
 * 信任是隐式的非交互模式。
 */
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
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  // 后台能力预取
  void prefetchOfficialMcpUrls();
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
    // 等待在模块评估时启动的异步子进程加载（第12-20行）。几乎免费——子进程在上述~135ms的导入期间完成。必须在init()之前解析，init()会触发第一次设置读取（applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings') → isRemoteManagedSettingsEligible → 同步钥匙串读取否则~65ms）。
    await ensureMdmSettingsLoaded();
    profileCheckpoint('preAction_after_mdm');
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

    // gh-33508: --plugin-dir是一个顶级程序选项。默认动作从其自身选项解构中读取它，但子命令（plugin list、plugin install、mcp *）有自己的动作，从未看到它。在此处连接，使得getInlinePlugins()在所有地方工作。thisCommand.opts()在此处被类型化为{}，因为此钩子是在链中的.option('--plugin-dir', ...)之前附加的——extra-typings在添加选项时构建类型。使用运行时守卫收窄类型；collect累加器+[]默认值在实践中保证string[]。
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }
    runMigrations();
    profileCheckpoint('preAction_after_migrations');

  });
  program.name('claude').description(`Claude Code - starts an interactive session by default, use -p/--print for non-interactive output`).argument('[prompt]', 'Your prompt', String)
  // Subcommands inherit helpOption via commander's copyInheritedSettings —
  // setting it once here covers mcp, plugin, auth, and all other subcommands.
  .helpOption('-h, --help', 'Display help for command').option('-d, --debug [filter]', 'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")', (_value: string | true) => {
    // 如果提供了值，它将是过滤字符串；如果未提供但标志存在，值将为true。实际过滤由debug.ts通过解析process.argv处理。
    return true;
  }).addOption(new Option('--debug-to-stderr', 'Enable debug mode (to stderr)').argParser(Boolean).hideHelp()).option('--debug-file <path>', 'Write debug logs to a specific file path (implicitly enables debug mode)', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).option('-p, --print', 'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust.', () => true).option('--bare', 'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic requests use ANTHROPIC_API_KEY only. 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.', () => true).addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp()).addOption(new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp()).addOption(new Option('--maintenance', 'Run Setup hooks with maintenance trigger, then continue').hideHelp()).addOption(new Option('--output-format <format>', 'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)').choices(['text', 'json', 'stream-json'])).addOption(new Option('--json-schema <schema>', 'JSON Schema for structured output validation. ' + 'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}').argParser(String)).option('--include-hook-events', 'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)', () => true).option('--include-partial-messages', 'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)', () => true).addOption(new Option('--input-format <format>', 'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)').choices(['text', 'stream-json'])).option('--mcp-debug', '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)', () => true).option('--dangerously-skip-permissions', 'Bypass all permission checks. Recommended only for sandboxes with no internet access.', () => true).option('--allow-dangerously-skip-permissions', 'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.', () => true).addOption(new Option('--thinking <mode>', 'Thinking mode: enabled (equivalent to adaptive), disabled').choices(['enabled', 'adaptive', 'disabled']).hideHelp()).addOption(new Option('--max-thinking-tokens <tokens>', '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-turns <turns>', 'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-budget-usd <amount>', 'Maximum dollar amount to spend on API calls (only works with --print)').argParser(value => {
    const amount = Number(value);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('--max-budget-usd must be a positive number greater than 0');
    }
    return amount;
  })).addOption(new Option('--task-budget <tokens>', 'API-side task budget in tokens (output_config.task_budget)').argParser(value => {
    const tokens = Number(value);
    if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('--task-budget must be a positive integer');
    }
    return tokens;
  }).hideHelp()).option('--replay-user-messages', 'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)', () => true).addOption(new Option('--enable-auth-status', 'Enable auth status messages in SDK mode').default(false).hideHelp()).option('--allowedTools, --allowed-tools <tools...>', 'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")').option('--tools <tools...>', 'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").').option('--disallowedTools, --disallowed-tools <tools...>', 'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")').option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings (space-separated)').addOption(new Option('--permission-prompt-tool <tool>', 'MCP tool to use for permission prompts (only works with --print)').argParser(String).hideHelp()).addOption(new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(String)).addOption(new Option('--system-prompt-file <file>', 'Read system prompt from a file').argParser(String).hideHelp()).addOption(new Option('--append-system-prompt <prompt>', 'Append a system prompt to the default system prompt').argParser(String)).addOption(new Option('--append-system-prompt-file <file>', 'Read system prompt from a file and append to the default system prompt').argParser(String).hideHelp()).addOption(new Option('--permission-mode <mode>', 'Permission mode to use for the session').argParser(String).choices(PERMISSION_MODES)).option('-c, --continue', 'Continue the most recent conversation in the current directory', () => true).option('-r, --resume [value]', 'Resume a conversation by session ID, or open interactive picker with optional search term', value => value || true).option('--fork-session', 'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)', () => true).addOption(new Option('--prefill <text>', 'Pre-fill the prompt input with text without submitting it').hideHelp()).option('--from-pr [value]', 'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term', value => value || true).option('--no-session-persistence', 'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)').addOption(new Option('--resume-session-at <message id>', 'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)').argParser(String).hideHelp()).addOption(new Option('--rewind-files <user-message-id>', 'Restore files to state at the specified user message and exit (requires --resume)').hideHelp())
  // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
  .option('--model <model>', `Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').`).addOption(new Option('--effort <level>', `Effort level for the current session (low, medium, high, max)`).argParser((rawValue: string) => {
    const value = rawValue.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'max'];
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`);
    }
    return value;
  })).option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`).option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)').option('--fallback-model <model>', 'Enable automatic fallback to specified model when default model is overloaded (only works with --print)').addOption(new Option('--workload <tag>', 'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)').hideHelp()).option('--settings <file-or-json>', 'Path to a settings JSON file or a JSON string to load additional settings from').option('--add-dir <directories...>', 'Additional directories to allow tool access to').option('--ide', 'Automatically connect to IDE on startup if exactly one valid IDE is available', () => true).option('--strict-mcp-config', 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations', () => true).option('--session-id <uuid>', 'Use a specific session ID for the conversation (must be a valid UUID)').option('-n, --name <name>', 'Set a display name for this session (shown in /resume and terminal title)').option('--agents <json>', 'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
  // gh-33508: <paths...> (variadic) consumed everything until the next
  // --flag. `claude --plugin-dir /path mcp add --transport http` swallowed
  // `mcp` and `add` as paths, then choked on --transport as an unknown
  // top-level option. Single-value + collect accumulator means each
  // --plugin-dir takes exactly one arg; repeat the flag for multiple dirs.
  .option('--plugin-dir <path>', 'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)', (val: string, prev: string[]) => [...prev, val], [] as string[]).option('--disable-slash-commands', 'Disable all skills', () => true).action(async (prompt, options) => {
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

    // 来自--channels标志的频道服务器允许列表——其入站推送通知应注册此会话的服务器。该选项在feature()块内添加，因此TS在选项类型上不知道它——与main.tsx:1824处的--assistant相同的模式。devChannels被延迟：showSetupScreens显示确认对话框，仅在接受时追加到allowedChannels。
    let devChannels: ChannelEntry[] | undefined;
    if (feature('MCP_CHANNELS')) {
      // 将 plugin:name@marketplace / server:Y 标签解析为类型化条目。标签决定下游信任模型：plugin-kind 命中市场验证 + 本地特性配置允许列表，server-kind 始终无法通过允许列表（模式仅为插件专用），除非设置了 dev 标志。无标签或缺少市场的插件条目是硬错误——在网关中静默不匹配会看起来像是通道已“开启”但从未触发。
      /** 解析 parse Channel Entries 对应的数据或状态。 */
      const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
        const entries: ChannelEntry[] = [];
        const bad: string[] = [];
        for (const c of raw) {
          if (c.startsWith('plugin:')) {
            const rest = c.slice(7);
            const at = rest.indexOf('@');
            if (at <= 0 || at === rest.length - 1) {
              bad.push(c);
            } else {
              entries.push({
                kind: 'plugin',
                name: rest.slice(0, at),
                marketplace: rest.slice(at + 1)
              });
            }
          } else if (c.startsWith('server:') && c.length > 7) {
            entries.push({
              kind: 'server',
              name: c.slice(7)
            });
          } else {
            bad.push(c);
          }
        }
        if (bad.length > 0) {
          process.stderr.write(chalk.red(`${flag} entries must be tagged: ${bad.join(', ')}\n` + `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` + `  server:<name>                — manually configured MCP server\n`));
          process.exit(1);
        }
        return entries;
      };
      const channelOpts = options as {
        channels?: string[];
        dangerouslyLoadDevelopmentChannels?: string[];
      };
      const rawChannels = channelOpts.channels;
      const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels;
      // 始终解析并设置允许的通道列表。在启动界面中渲染适当的分支（disabled/noAuth/policyBlocked/listening）。gateChannelServer() 强制执行。--channels 在交互式和 print/SDK 模式下均有效；dev-channels 仅限交互式（需要确认对话框）。
      let channelEntries: ChannelEntry[] = [];
      if (rawChannels && rawChannels.length > 0) {
        channelEntries = parseChannelEntries(rawChannels, '--channels');
        setAllowedChannels(channelEntries);
      }
      if (!isNonInteractiveSession) {
        if (rawDev && rawDev.length > 0) {
          devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels');
        }
      }
    }

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
      // 现在应用完全合并的设置环境（包括项目范围的 .claude/settings.json PATH/GIT_DIR/GIT_WORK_TREE），以便 gitExe() 和下面的 git spawn 能够看到它们。信任在 -p 模式下是隐式的；managedEnv.ts:96-97 的文档字符串说明这应用来自所有来源的“潜在危险的环境变量如 LD_PRELOAD、PATH”。下面的 isNonInteractiveSession 块中的后续调用是幂等的（Object.assign，configureGlobalAgents 弹出之前的拦截器），并在插件初始化后获取任何插件贡献的环境。项目设置已经在这里加载：init() 中的 applySafeConfigEnvironmentVariables 调用了 managedEnv.ts:86 的 getSettings_DEPRECATED，它合并了所有启用的来源，包括 projectSettings/localSettings。
      applyConfigEnvironmentVariables();

      // 现在生成 git status/log/branch，以便子进程执行与下面的 getCommands await 和 startDeferredPrefetches 重叠。在 setup() 之后，以便 cwd 是最终的（setup.ts:254 可能对 --worktree 执行 process.chdir(worktreePath)），并且在上述 applyConfigEnvironmentVariables 之后，以便来自所有来源（受信任 + 项目）的 PATH/GIT_DIR/GIT_WORK_TREE 被应用。getSystemContext 被记忆化；startDeferredPrefetches 中的 prefetchSystemContextIfSafe 调用变为缓存命中。await getIsGit() 产生的微任务在下面的 getCommands Promise.all await 中耗尽。信任在 -p 模式下是隐式的（与 prefetchSystemContextIfSafe 相同的条件）。
      void getSystemContext();
      // 现在也启动 getUserContext——其第一个 await（getMemoryFiles 中的 fs.readFile）自然让步，因此 CLAUDE.md 目录遍历在 print.ts 中上下文 Promise.all 合并之前约 280ms 的重叠窗口期间运行。startDeferredPrefetches 中的 void getUserContext() 变为记忆化缓存命中。
      void getUserContext();
      // 现在启动 ensureModelStringsInitialized——对于 Bedrock，这会触发一个 100-200ms 的配置文件获取，之前是在 print.ts:739 串行等待的。updateBedrockModelStrings 被 sequential() 包装，因此 await 会加入正在进行的获取。非 Bedrock 是同步早期返回（零成本）。
      void ensureModelStringsInitialized();
    }

    // 应用 --name: cache-only，因此在会话 ID 由 --continue/--resume 最终确定之前不会创建孤立文件。materializeSessionFile 在第一条用户消息时持久化它；REPL 的 useTerminalTitle 通过 getCurrentSessionTitle 读取它。
    const sessionNameArg = options.name?.trim();
    if (sessionNameArg) {
      cacheSessionTitle(sessionNameArg);
    }

    // 使用 null 关键字对默认模型进行特殊处理。注意：模型解析发生在 setup() 之后，以确保在 AWS 认证之前建立信任。
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
    let advisorModel: string | undefined;
    if (isAdvisorEnabled()) {
      const advisorOption = canUserConfigureAdvisor() ? (options as {
        advisor?: string;
      }).advisor : undefined;
      if (advisorOption) {
        logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`);
        if (!modelSupportsAdvisor(resolvedInitialModel)) {
          process.stderr.write(chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`));
          process.exit(1);
        }
        const normalizedAdvisorModel = normalizeModelStringForAPI(parseUserSpecifiedModel(advisorOption));
        if (!isValidAdvisorModel(normalizedAdvisorModel)) {
          process.stderr.write(chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`));
          process.exit(1);
        }
      }
      advisorModel = canUserConfigureAdvisor() ? advisorOption ?? getInitialAdvisorSetting() : advisorOption;
      if (advisorModel) {
        logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`);
      }
    }

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
      await showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands, devChannels);
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
    // 并逐个推送服务器（如下），以便 ToolSearch 的 pending-client 处理正常工作
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
    } else {
      const maxThinkingTokens = process.env.MAX_THINKING_TOKENS ? parseInt(process.env.MAX_THINKING_TOKENS, 10) : options.maxThinkingTokens;
      if (maxThinkingTokens !== undefined) {
        if (maxThinkingTokens > 0) {
          thinkingEnabled = true;
          thinkingConfig = {
            type: 'enabled',
            budgetTokens: maxThinkingTokens
          };
        } else if (maxThinkingTokens === 0) {
          thinkingEnabled = false;
          thinkingConfig = {
            type: 'disabled'
          };
        }
      }
    }
    logForDiagnosticsNoPII('info', 'started', {
      version: MACRO.VERSION,
      is_native_binary: isInBundledMode()
    });
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'exited');
    });
    // 为并发会话检测（~/.claude/sessions/）注册 PID 文件
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
    // 下一个交互式会话会进行协调。这里的 await 在 marketplace 往返上阻塞了 -p。
    if (!isBareMode() && isNonInteractiveSession) {
      // 在无头模式下，在 CLI 退出前等待以确保插件同步完成
      await initializeVersionedPlugins();
      profileCheckpoint('action_after_plugins_init');
      void cleanupOrphanedPluginVersionsInBackground().then(() => getGlobExclusionsForPluginCache());
    } else if (!isBareMode()) {
      // 在交互模式下，即发即忘——这纯粹是记账操作，不影响当前会话的运行时行为
      void initializeVersionedPlugins().then(async () => {
        profileCheckpoint('action_after_plugins_init');
        await cleanupOrphanedPluginVersionsInBackground();
        void getGlobExclusionsForPluginCache();
      });
    }
    const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
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
        ...(isAdvisorEnabled() && advisorModel && {
          advisorModel
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
      // 镜像useManageMCPConnections——先推送待处理项（以便ToolSearch在ToolSearchTool.ts:334处的待处理检查能看到它们），
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
        enableAuthStatus: options.enableAuthStatus,
        agent: agentCli,
        workload: options.workload,
        setupTrigger: setupTrigger ?? undefined,
        sessionStartHooksPromise
      });
      return;
    }

    // 启动时记录模型配置

    // 获取初始模型的弃用警告（resolvedInitialModel提前计算以并行化钩子）
    const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel);

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
    if (deprecationWarning) {
      initialNotifications.push({
        key: 'model-deprecation-warning',
        text: deprecationWarning,
        color: 'warning',
        priority: 'high'
      });
    }
    const effectiveToolPermissionContext = {
      ...toolPermissionContext,
      mode: isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired() ? 'plan' as const : toolPermissionContext.mode
    };
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
        installationStatus: {
          marketplaces: [],
          plugins: []
        },
        needsRefresh: false
      },
      statusLineText: undefined,

      notifications: {
        current: null,
        queue: initialNotifications
      },
      elicitation: {
        queue: []
      },
      todos: {},
      fileHistory: {
        snapshots: [],
        trackedFiles: new Set(),
        snapshotSequence: 0
      },
      attribution: createEmptyAttributionState(),
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
      ...(isAdvisorEnabled() && advisorModel && {
        advisorModel
      }),
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
          includeAttribution: true,
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
  }).version(`${MACRO.VERSION} (Claude Code)`, '-v, --version', 'Output the version number');

  // 工作树标志
  program.option('-w, --worktree [name]', 'Create a new git worktree for this session (optionally specify a name)');
  program.option('--tmux', 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.');
  if (canUserConfigureAdvisor()) {
    program.addOption(new Option('--advisor <model>', 'Enable the server-side advisor tool with the specified model (alias or full ID).').hideHelp());
  }
  program.addOption(new Option('--tasks [id]', 'Watch a task list and automatically process available tasks.').argParser(String));
  program.option('--agent-teams', 'Enable multi-agent mode for this session', () => true);
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }
  if (feature('PROACTIVE')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }
  if (feature('MCP_CHANNELS')) {
    program.addOption(new Option('--channels <servers...>', 'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.').hideHelp());
    program.addOption(new Option('--dangerously-load-development-channels <servers...>', 'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.').hideHelp());
  }

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

  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp());
  }
  profileCheckpoint('run_main_options_built');

  // -p/--print模式跳过子命令注册，因为Commander直接将提示路由到默认动作。
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  if (isPrintMode) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // MCP 子命令

  const mcp = program.command('mcp').description('Configure and manage MCP servers').configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  mcp.command('serve').description(`Start the Claude Code MCP server`).option('-d, --debug', 'Enable debug mode', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).action(async ({
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
  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp);
  }
  mcp.command('remove <name>').description('Remove an MCP server').option('-s, --scope <scope>', 'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in').action(async (name: string, options: {
    scope?: string;
  }) => {
    const {
      mcpRemoveHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpRemoveHandler(name, options);
  });
  mcp.command('list').description('List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async () => {
    const {
      mcpListHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpListHandler();
  });
  mcp.command('get <name>').description('Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async (name: string) => {
    const {
      mcpGetHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpGetHandler(name);
  });
  mcp.command('add-json <name> <json>').description('Add an MCP server (stdio or SSE) with a JSON string').option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local').option('--client-secret', 'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)').action(async (name: string, json: string, options: {
    scope?: string;
    clientSecret?: true;
  }) => {
    const {
      mcpAddJsonHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddJsonHandler(name, json, options);
  });
  mcp.command('add-from-claude-desktop').description('Import MCP servers from Claude Desktop (Mac and WSL only)').option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local').action(async (options: {
    scope?: string;
  }) => {
    const {
      mcpAddFromDesktopHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddFromDesktopHandler(options);
  });
  mcp.command('reset-project-choices').description('Reset all approved and rejected project-scoped (.mcp.json) servers within this project').action(async () => {
    const {
      mcpResetChoicesHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpResetChoicesHandler();
  });

  // 克劳德·奥特

  /**
   * 帮助函数一致地处理市场命令错误。
   * 记录错误并以状态 1 退出进程。
   * @param error 发生的错误
   * @param action 失败操作的描述
   */
  // 所有插件/市场子命令上的隐藏标志以定位 cowork_plugins。
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp();

  // 插件验证命令
  const pluginCmd = program.command('plugin').alias('plugins').description('Manage Claude Code plugins').configureHelp(createSortedHelpConfig());
  pluginCmd.command('validate <path>').description('Validate a plugin or marketplace manifest').addOption(coworkOption()).action(async (manifestPath: string, options: {
    cowork?: boolean;
  }) => {
    const {
      pluginValidateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginValidateHandler(manifestPath, options);
  });

  // 插件列表命令
  pluginCmd.command('list').description('List installed plugins').option('--json', 'Output as JSON').option('--available', 'Include available plugins from marketplaces (requires --json)').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    available?: boolean;
    cowork?: boolean;
  }) => {
    const {
      pluginListHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginListHandler(options);
  });

  // 市场子命令
  const marketplaceCmd = pluginCmd.command('marketplace').description('Manage Claude Code marketplaces').configureHelp(createSortedHelpConfig());
  marketplaceCmd.command('add <source>').description('Add a marketplace from a URL, path, or GitHub repo').addOption(coworkOption()).option('--sparse <paths...>', 'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins').option('--scope <scope>', 'Where to declare the marketplace: user (default), project, or local').action(async (source: string, options: {
    cowork?: boolean;
    sparse?: string[];
    scope?: string;
  }) => {
    const {
      marketplaceAddHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceAddHandler(source, options);
  });
  marketplaceCmd.command('list').description('List all configured marketplaces').option('--json', 'Output as JSON').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    cowork?: boolean;
  }) => {
    const {
      marketplaceListHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceListHandler(options);
  });
  marketplaceCmd.command('remove <name>').alias('rm').description('Remove a configured marketplace').addOption(coworkOption()).action(async (name: string, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceRemoveHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceRemoveHandler(name, options);
  });
  marketplaceCmd.command('update [name]').description('Update marketplace(s) from their source - updates all if no name specified').addOption(coworkOption()).action(async (name: string | undefined, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceUpdateHandler(name, options);
  });

  // 插件安装命令
  pluginCmd.command('install <plugin>').alias('i').description('Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)').option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user').addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginInstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginInstallHandler(plugin, options);
  });

  // 插件卸载命令
  pluginCmd.command('uninstall <plugin>').alias('remove').alias('rm').description('Uninstall an installed plugin').option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user').option('--keep-data', "Preserve the plugin's persistent data directory (~/.claude/plugins/data/{id}/)").addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
    keepData?: boolean;
  }) => {
    const {
      pluginUninstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUninstallHandler(plugin, options);
  });

  // 插件启用命令
  pluginCmd.command('enable <plugin>').description('Enable a disabled plugin').option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginEnableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginEnableHandler(plugin, options);
  });

  // 插件禁用命令
  pluginCmd.command('disable [plugin]').description('Disable an enabled plugin').option('-a, --all', 'Disable all enabled plugins').option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`).addOption(coworkOption()).action(async (plugin: string | undefined, options: {
    scope?: string;
    cowork?: boolean;
    all?: boolean;
  }) => {
    const {
      pluginDisableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginDisableHandler(plugin, options);
  });

  // 插件更新命令
  pluginCmd.command('update <plugin>').description('Update a plugin to the latest version (restart required to apply)').option('-s, --scope <scope>', `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUpdateHandler(plugin, options);
  });
  // Agents命令 — 列出已配置的agents
  program.command('agents').description('List configured agents').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).').action(async () => {
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
      const autoModeCmd = program.command('auto-mode').description('Inspect auto mode classifier configuration');
      autoModeCmd.command('defaults').description('Print the default auto mode environment, allow, and deny rules as JSON').action(async () => {
        const {
          autoModeDefaultsHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeDefaultsHandler();
        process.exit(0);
      });
      autoModeCmd.command('config').description('Print the effective auto mode config as JSON: your settings where set, defaults otherwise').action(async () => {
        const {
          autoModeConfigHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeConfigHandler();
        process.exit(0);
      });
      autoModeCmd.command('critique').description('Get AI feedback on your custom auto mode rules').option('--model <model>', 'Override which model is used').action(async options => {
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
