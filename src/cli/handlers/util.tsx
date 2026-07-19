/**
 * 杂项子命令处理程序 — 从 main.tsx 提取以便懒加载。
 * Doctor 诊断界面。
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import React from 'react';
import type { Root } from '../../ink.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js';
import { AppStateProvider } from '../../state/AppState.js';

// DoctorWithPlugins 包装器 + doctor 处理程序
const DoctorLazy = React.lazy(() =>
  import('../../screens/Doctor.js').then(module => ({ default: module.Doctor })),
)


/** 执行 doctor Handler 对应的业务处理。 */
export async function doctorHandler(root: Root): Promise<void> {
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <MCPConnectionManager
            dynamicMcpConfig={undefined}
            isStrictMcpConfig={false}
          >
            <React.Suspense fallback={null}>
              <DoctorLazy onDone={resolve} />
            </React.Suspense>
          </MCPConnectionManager>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  process.exit(0)
}
