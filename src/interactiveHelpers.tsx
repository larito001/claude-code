import { feature } from 'src/utils/features.js';
import { appendFileSync } from 'fs';
import React from 'react';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { type ChannelEntry, getAllowedChannels, setAllowedChannels, setHasDevChannels, setSessionTrustAccepted, setStatsStore } from './bootstrap/state.js';
import { createStatsStore, type StatsStore } from './context/stats.js';
import { getSystemContext } from './context.js';
import { initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { isSynchronizedOutputSupported } from './ink/terminal.js';
import type { RenderOptions, Root, TextProps } from './ink.js';
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js';
import { startDeferredPrefetches } from './main.js';
import { isFeatureEnabled, initializeFeatureConfig, resetFeatureConfig } from './services/featureConfig.js';
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js';
import { AppStateProvider } from './state/AppState.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { getExternalClaudeMdIncludes, getMemoryFiles, shouldShowClaudeMdExternalIncludesWarning } from './utils/claudemd.js';
import { checkHasTrustDialogAccepted, getGlobalConfig, saveGlobalConfig } from './utils/config.js';
import { isEnvTruthy } from './utils/envUtils.js';
import { type FpsMetrics, FpsTracker } from './utils/fpsTracker.js';
import { updateGithubRepoPathMapping } from './utils/githubRepoPathMapping.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import type { PermissionMode } from './utils/permissions/PermissionMode.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js';
import { hasAutoModeOptIn, hasSkipDangerousModePermissionPrompt } from './utils/settings/settings.js';
/** 执行 complete Onboarding 对应的业务处理。 */
export function completeOnboarding(): void {
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION
  }));
}
/** 执行 show Dialog 对应的业务处理。 */
export function showDialog<T = void>(root: Root, renderer: (done: (result: T) => void) => React.ReactNode): Promise<T> {
  return new Promise<T>(resolve => {
    /** 执行 done 对应的业务处理。 */
    const done = (result: T): void => void resolve(result);
    root.render(renderer(done));
  });
}

/**
 * 通过 Ink 渲染错误消息，然后卸载并退出。
 * 在创建 Ink 根节点后用于致命错误——
 * console.error 被 Ink 的 patchConsole 吞没，所以我们改为通过 React 树渲染。
 */
export async function exitWithError(root: Root, message: string, beforeExit?: () => Promise<void>): Promise<never> {
  return exitWithMessage(root, message, {
    color: 'error',
    beforeExit
  });
}

/**
 * 通过 Ink 渲染消息，然后卸载并退出。
 * 在创建 Ink 根节点后用于消息——
 * console 输出被 Ink 的 patchConsole 吞没，所以我们改为通过 React 树渲染。
 */
export async function exitWithMessage(root: Root, message: string, options?: {
  color?: TextProps['color'];
  exitCode?: number;
  /** 执行 before Exit 对应的业务处理。 */
  beforeExit?: () => Promise<void>;
}): Promise<never> {
  const {
    Text
  } = await import('./ink.js');
  const color = options?.color;
  const exitCode = options?.exitCode ?? 1;
  root.render(color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>);
  root.unmount();
  await options?.beforeExit?.();
  // eslint-disable-next-line custom-rules/no-process-exit -- exit after Ink unmount
  process.exit(exitCode);
}

/**
 * 显示包裹在 AppStateProvider + KeybindingSetup 中的设置对话框。
 * 减少 showSetupScreens() 中每个对话框都需要这些包装器的样板代码。
 */
export function showSetupDialog<T = void>(root: Root, renderer: (done: (result: T) => void) => React.ReactNode, options?: {
  onChangeAppState?: typeof onChangeAppState;
}): Promise<T> {
  return showDialog<T>(root, done => <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>{renderer(done)}</KeybindingSetup>
    </AppStateProvider>);
}

/**
 * 将主 UI 渲染到根节点中，并等待其退出。
 * 处理常见的收尾工作：启动延迟预取，等待退出，优雅关闭。
 */
export async function renderAndRun(root: Root, element: React.ReactNode): Promise<void> {
  root.render(element);
  startDeferredPrefetches();
  await root.waitUntilExit();
  await gracefulShutdown(0);
}
/** 执行 show Setup Screens 对应的业务处理。 */
export async function showSetupScreens(root: Root, permissionMode: PermissionMode, allowDangerouslySkipPermissions: boolean, devChannels?: ChannelEntry[]): Promise<void> {
  if (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_ONBOARDING)
  ) {
    return;
  }
  const config = getGlobalConfig();
  if (!config.theme || !config.hasCompletedOnboarding // 始终至少显示一次引导流程
  ) {
    const {
      Onboarding
    } = await import('./components/Onboarding.js');
    await showSetupDialog(root, done => <Onboarding onDone={() => {
      completeOnboarding();
      void done();
    }} />, {
      onChangeAppState
    });
  }

  // 在交互式会话中始终显示信任对话框，无论权限模式如何。
  // 信任对话框是工作区信任边界——它警告不受信任的仓库
  // 并检查 CLAUDE.md 外部包含。bypassPermissions 模式
  // 仅影响工具执行权限，不影响工作区信任。
  // 注意：非交互式会话（使用 -p 的 CI/CD）永远不会到达 showSetupScreens。
  // 在 claubbit 中跳过权限检查
  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    // 快速路径：当 CWD 已被信任时跳过 TrustDialog 导入+渲染。
    // 如果返回 true，则 TrustDialog 将自动解析，无论
    // 安全特性如何，因此我们可以跳过动态导入和渲染循环。
    if (!checkHasTrustDialogAccepted()) {
      const {
        TrustDialog
      } = await import('./components/TrustDialog/TrustDialog.js');
      await showSetupDialog(root, done => <TrustDialog onDone={done} />);
    }

    // 表示信任已针对此会话得到验证。
    setSessionTrustAccepted(true);

    // 在信任建立对设置的访问后重新初始化功能开关。
    resetFeatureConfig();
    void initializeFeatureConfig();

    // 既然已建立信任，则预取系统上下文（如果尚未预取）
    void getSystemContext();

    // 如果设置有效，检查是否有任何 mcp.json 服务器需要批准
    const {
      errors: allErrors
    } = getSettingsWithAllErrors();
    if (allErrors.length === 0) {
      await handleMcpjsonServerApprovals(root);
    }

    // 检查是否有 claude.md 包含项需要批准
    if (await shouldShowClaudeMdExternalIncludesWarning()) {
      const externalIncludes = getExternalClaudeMdIncludes(await getMemoryFiles(true));
      const {
        ClaudeMdExternalIncludesDialog
      } = await import('./components/ClaudeMdExternalIncludesDialog.js');
      await showSetupDialog(root, done => <ClaudeMdExternalIncludesDialog onDone={done} isStandaloneDialog externalIncludes={externalIncludes} />);
    }
  }

  // 跟踪当前仓库路径（即发即忘）
  // 这必须在信任之后进行，以防止不受信任的目录污染映射
  void updateGithubRepoPathMapping();
  // 在信任对话框被接受后或在绕过模式下应用完整的环境变量
  // 在绕过模式（CI/CD、自动化）中，我们信任环境，因此应用所有变量
  // 在正常模式下，这是在信任对话框被接受后进行的
  // 这包括来自不受信任来源的潜在危险环境变量
  applyConfigEnvironmentVariables();

  // 在应用环境变量后初始化遥测，以便 OTEL 端点环境变量和
  // otelHeadersHelper（需要信任才能执行）可用。
  // 推迟到下一个微任务，以便 OTel 动态导入在首次渲染后解析，
  // 而不是在预渲染微任务队列期间。
  setImmediate(() => initializeTelemetryAfterTrust());
  if ((permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) && !hasSkipDangerousModePermissionPrompt()) {
    const {
      BypassPermissionsModeDialog
    } = await import('./components/BypassPermissionsModeDialog.js');
    await showSetupDialog(root, done => <BypassPermissionsModeDialog onAccept={done} />);
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 仅当自动模式实际解析时才显示选择加入对话框——如果
    // 门控拒绝（组织未列入白名单、设置禁用），则显示
    // 同意不可用的功能是没有意义的。
    // verifyAutoModeGateAccess 通知将解释原因。
    if (permissionMode === 'auto' && !hasAutoModeOptIn()) {
      const {
        AutoModeOptInDialog
      } = await import('./components/AutoModeOptInDialog.js');
      await showSetupDialog(root, done => <AutoModeOptInDialog onAccept={done} onDecline={() => gracefulShutdownSync(1)} declineExits />);
    }
  }

  // --dangerously-load-development-channels 确认。接受后，将开发频道追加到
  // main.tsx 中已设置的 --channels 列表中。组织策略
  // 不会被绕过——gateChannelServer() 仍然运行；此标志仅存在
  // 用于绕过 --channels 批准的服务器白名单。
  if (feature('MCP_CHANNELS')) {
    // 频道门控在此函数返回后读取 tengu_harbor。
    // 冷磁盘缓存（新安装，或首次在服务端添加标志后运行）默认值为 false，并静默丢弃
    // 整个会话的频道通知——gh#37026。
    // isFeatureEnabled 如果磁盘已为 true 则立即返回；仅在冷/过时-false 缓存上阻塞（等待之前触发的相同记忆化的
    // initializeFeatureConfig promise）。同时预热下面开发频道对话框中的 isChannelsEnabled() 检查。
    if (getAllowedChannels().length > 0 || (devChannels?.length ?? 0) > 0) {
      await isFeatureEnabled('tengu_harbor');
    }
    if (devChannels && devChannels.length > 0) {
      const {
        DevChannelsDialog
      } = await import('./components/DevChannelsDialog.js');
      await showSetupDialog(root, done => <DevChannelsDialog channels={devChannels} onAccept={() => {
        setAllowedChannels([...getAllowedChannels(), ...devChannels.map(c => ({
          ...c,
          dev: true
        }))]);
        setHasDevChannels(true);
        void done();
      }} />);
    }
  }

}
/** 获取 get Render Context 对应的数据或状态。 */
export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions;
  /** 获取 get Fps Metrics 对应的数据或状态。 */
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
} {
  const baseOptions = getBaseRenderOptions(exitOnCtrlC);

  const fpsTracker = new FpsTracker();
  const stats = createStatsStore();
  setStatsStore(stats);

  // 基准模式：设置后，以 JSONL 格式附加每帧阶段时序，用于
  // 离线分析（bench/repl-scroll.ts）。捕获完整的 TUI
  // 渲染管道（yoga → screen buffer → diff → optimize → stdout）
  // 以便任何阶段的性能工作都可以针对真实用户流程进行验证。
  const frameTimingLogPath = process.env.CLAUDE_CODE_FRAME_TIMING_LOG;
  return {
    /** 获取 get Fps Metrics 对应的数据或状态。 */
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      /** 处理 on Frame 对应的数据或状态。 */
      onFrame: event => {
        fpsTracker.record(event.durationMs);
        stats.observe('frame_duration_ms', event.durationMs);
        if (frameTimingLogPath && event.phases) {
          // 仅基准环境变量门控路径：同步写入，因此在突然退出时不会丢失帧。
          // 在≤60fps 时约100字节可忽略。rss/cpu 是
          // 单个系统调用；cpu 是累积的——基准端计算增量。
          const line =
          // eslint-disable-next-line custom-rules/no-direct-json-operations -- tiny object, hot bench path
          JSON.stringify({
            total: event.durationMs,
            ...event.phases,
            rss: process.memoryUsage.rss(),
            cpu: process.cpuUsage()
          }) + '\n';
          // eslint-disable-next-line custom-rules/no-sync-fs -- bench-only, sync so no frames dropped on exit
          appendFileSync(frameTimingLogPath, line);
        }
        // 跳过具有同步输出终端的闪烁报告——
        // DEC 2026 在 BSU/ESU 之间缓冲，因此清除+重绘是原子的。
        if (isSynchronizedOutputSupported()) {
          return;
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue;
          }
        }
      }
    }
  };
}
