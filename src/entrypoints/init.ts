import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import type { AttributedCounter } from '../bootstrap/state.js'
import { getSessionCounter, setMeter } from '../bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在错误路径中动态导入，以避免在初始化时加载 React
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utils/gracefulShutdown.js'
import { applySafeConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
// initializeTelemetry 通过 import() 在 setMeterState() 中懒加载，将约 400KB 的 OpenTelemetry 和 protobuf 模块推迟到遥测实际初始化时加载。gRPC 导出器（约 700KB，通过 @grpc/grpc-js）进一步在 instrumentation.ts 中懒加载。
import { configureGlobalAgents } from '../utils/proxy.js'
import { getTelemetryAttributes } from '../utils/telemetryAttributes.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'

// 跟踪遥测是否已初始化，以防止重复初始化
let telemetryInitialized = false

/** 执行 init 对应的业务处理。 */
export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 验证配置是否有效并启用配置系统
  try {
    const configsStart = Date.now()
    enableConfigs()
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在信任对话框之前仅应用安全的环境变量，完整的环境变量在信任建立后应用
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 尽早将 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env，在任何 TLS 连接之前。Bun 通过 BoringSSL 在启动时缓存 TLS 证书存储，因此必须在第一次 TLS 握手之前完成此操作。
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保退出时刷新数据
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 异步初始化 JetBrains IDE 检测（填充缓存以供后续同步访问）
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（填充缓存以供 gitDiff PR 链接使用）
    void detectCurrentRepository()

    // 配置全局 mTLS 设置
    const mtlsStart = Date.now()
    logForDebugging('[init] configureGlobalMTLS starting')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    logForDebugging('[init] configureGlobalMTLS complete')

    // 配置全局 HTTP 代理（代理和/或 mTLS）
    const proxyStart = Date.now()
    logForDebugging('[init] configureGlobalAgents starting')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    logForDebugging('[init] configureGlobalAgents complete')
    profileCheckpoint('init_network_configured')

    // 预连接到 Anthropic API — 将 TCP+TLS 握手（约 100-200 毫秒）与 API 请求前约 100 毫秒的操作处理工作重叠。在配置 CA 证书和代理代理后，预热连接使用正确的传输。即发即弃；对于代理/mTLS/Unix/云提供商的场景跳过，因为 SDK 的调度器不会重用全局连接池。
    preconnectAnthropicApi()

    // 如果相关，设置 git-bash
    setShellIfWindows()

    // 注册 LSP 管理器清理（初始化在 main.tsx 中处理 --plugin-dir 后发生）
    registerCleanup(shutdownLspServerManager)

    // gh-32730：由子代理（或没有显式 TeamDelete 的主代理）创建的团队永远留在磁盘上。为此会话中创建的所有团队注册清理。懒导入：swarm 代码在特性门控后，大多数会话从不创建团队。
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 如果启用，初始化暂存目录
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      if (getIsNonInteractiveSession()) {
        process.stderr.write(
          `Configuration error in ${error.filePath}: ${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 显示带有错误对象的无效配置对话框，并等待其完成
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
      // 对话框本身处理了process.exit，因此我们不需要在此处进行额外的清理。
    } else {
      // 对于非配置错误，重新抛出它们
      throw error
    }
  }
})

/**
 * 在授予信任后初始化遥测。对于符合远程设置条件的用户，等待设置加载（非阻塞），然后重新应用环境变量（包括远程设置），然后初始化遥测。对于不符合条件的用户，立即初始化遥测。此函数应仅在信任对话框被接受后调用一次。
 */
export function initializeTelemetryAfterTrust(): void {
  void doInitializeTelemetry().catch(error => {
    logForDebugging(
      `[3P telemetry] Telemetry init failed: ${errorMessage(error)}`,
      { level: 'error' },
    )
  })
}

/** 执行 do Initialize Telemetry 对应的业务处理。 */
async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) {
    // 已初始化，无需操作
    return
  }

  // 在初始化前设置标志以防止双重初始化
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    // 失败时重置标志，以便后续调用可以重试
    telemetryInitialized = false
    throw error
  }
}

/** 设置并保存 set Meter State 对应的数据或状态。 */
async function setMeterState(): Promise<void> {
  // 懒加载 instrumentation 以推迟约 400KB 的 OpenTelemetry 和 protobuf
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  // 初始化客户OTLP遥测（指标、日志、跟踪）
  const meter = await initializeTelemetry()
  if (meter) {
    // 创建属性计数器的工厂函数
    const createAttributedCounter = (
      name: string,
      options: MetricOptions,
    ): AttributedCounter => {
      const counter = meter?.createCounter(name, options)

      return {
        /** 添加或注册 add 对应的数据或状态。 */
        add(value: number, additionalAttributes: Attributes = {}) {
          // 始终获取最新的遥测属性以确保它们是最新的
          const currentAttributes = getTelemetryAttributes()
          const mergedAttributes = {
            ...currentAttributes,
            ...additionalAttributes,
          }
          counter?.add(value, mergedAttributes)
        },
      }
    }

    setMeter(meter, createAttributedCounter)

    // 在此处增加会话计数器，因为启动遥测路径
    // 在此异步初始化完成之前运行，因此计数器
    // 在那里将为null。
    getSessionCounter()?.add(1)
  }
}
