/**
 * 用于 main.tsx 中一次性对话框 JSX 站点的薄启动器。
 * 每个启动器动态导入其组件，并以与原始内联调用点完全相同的方式连接 `done` 回调。零行为变更。
 *
 * 属于 main.tsx React/JSX 提取工作的一部分。参见同级 PR perf/extract-interactive-helpers 和 perf/launch-repl。
 */
import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import { renderAndRun, showSetupDialog } from './interactiveHelpers.js';
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import type { ValidationError } from './utils/settings/validation.js';

// 通过模块类型对 ResumeConversation 的 Props 进行仅类型访问。
// 无运行时开销——在编译时被擦除。
type ResumeConversationProps = React.ComponentProps<typeof import('./screens/ResumeConversation.js').ResumeConversation>;

/**
 * 站点 ~3250：InvalidSettingsDialog（设置验证错误）。
 * 原始回调连接：onContinue={done}，onExit 从调用者传递进来。
 */
export async function launchInvalidSettingsDialog(root: Root, props: {
  settingsErrors: ValidationError[];
  /** 处理 on Exit 对应的数据或状态。 */
  onExit: () => void;
}): Promise<void> {
  const {
    InvalidSettingsDialog
  } = await import('./components/InvalidSettingsDialog.js');
  return showSetupDialog(root, done => <InvalidSettingsDialog settingsErrors={props.settingsErrors} onContinue={done} onExit={props.onExit} />);
}

/**
 * 站点 ~4903：ResumeConversation 挂载（交互式会话选择器）。
 * 使用 renderAndRun，而非 showSetupDialog。包裹在 <App><KeybindingSetup> 中。
 * 保留原始的 getWorktreePaths 和导入之间的 Promise.all 并行性。
 */
export async function launchResumeChooser(root: Root, appProps: {
  /** 获取 get Fps Metrics 对应的数据或状态。 */
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
  initialState: AppState;
}, worktreePathsPromise: Promise<string[]>, resumeProps: Omit<ResumeConversationProps, 'worktreePaths'>): Promise<void> {
  const [worktreePaths, {
    ResumeConversation
  }, {
    App
  }] = await Promise.all([worktreePathsPromise, import('./screens/ResumeConversation.js'), import('./components/App.js')]);
  await renderAndRun(root, <App getFpsMetrics={appProps.getFpsMetrics} stats={appProps.stats} initialState={appProps.initialState}>
      <KeybindingSetup>
        <ResumeConversation {...resumeProps} worktreePaths={worktreePaths} />
      </KeybindingSetup>
    </App>);
}
