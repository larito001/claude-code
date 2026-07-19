import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
type AppWrapperProps = {
  /** 获取 get Fps Metrics 对应的数据或状态。 */
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};
/** 启动或启用 launch Repl 对应的数据或状态。 */
export async function launchRepl(root: Root, appProps: AppWrapperProps, replProps: REPLProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>): Promise<void> {
  const {
    App
  } = await import('./components/App.js');
  const {
    REPL
  } = await import('./screens/REPL.js');
  await renderAndRun(root, <App {...appProps}>
      <REPL {...replProps} />
    </App>);
}
