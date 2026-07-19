import axios from 'axios'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { getProxyUrl, shouldBypassProxy } from '../proxy.js'
// 作为命名空间导入，以便 spyOn 在测试中工作（直接导入会绕过 spy）
import * as settingsModule from '../settings/settings.js'
import type { HttpHook } from '../settings/types.js'
import { ssrfGuardedLookup } from './ssrfGuard.js'

const DEFAULT_HTTP_HOOK_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟（与 TOOL_HOOK_EXECUTION_TIMEOUT_MS 匹配）

/**
 * 获取沙箱代理配置，用于在启用沙箱时通过沙箱网络代理路由 HTTP 钩子请求。
 *
 * 使用动态导入以避免静态导入循环（sandbox-adapter -> settings -> ... -> hooks -> execHttpHook）。
 */
async function getSandboxProxyConfig(): Promise<
  { host: string; port: number; protocol: string } | undefined
> {
  const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')

  if (!SandboxManager.isSandboxingEnabled()) {
    return undefined
  }

  // 等待沙箱网络代理完成初始化。在 REPL 模式下，SandboxManager.initialize() 是即发即忘的，因此当第一个钩子触发时，代理可能尚未就绪。
  await SandboxManager.waitForNetworkInitialization()

  const proxyPort = SandboxManager.getProxyPort()
  if (!proxyPort) {
    return undefined
  }

  return { host: '127.0.0.1', port: proxyPort, protocol: 'http' }
}

/**
 * 从合并的设置（所有来源）中读取 HTTP 钩子允许列表限制。遵循 allowedMcpServers 的先例：数组在来源之间拼接。
 * 当托管设置中设置了 allowManagedHooksOnly 时，无论如何只有管理员定义的钩子运行，因此这里不需要单独的安全布尔值。
 */
function getHttpHookPolicy(): {
  allowedUrls: string[] | undefined
  allowedEnvVars: string[] | undefined
} {
  const settings = settingsModule.getInitialSettings()
  return {
    allowedUrls: settings.allowedHttpHookUrls,
    allowedEnvVars: settings.httpHookAllowedEnvVars,
  }
}

/**
 * 将 URL 与带有 * 作为通配符（任意字符）的模式进行匹配。
 * 语义与 MCP 服务器允许列表模式相同。
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`).test(url)
}

/**
 * 从标头值中去除 CR、LF 和 NUL 字节，以防止通过环境变量值或钩子配置的标头模板进行 HTTP 标头注入（CRLF 注入）。
 * 恶意的环境变量（如 "token\r\nX-Evil: 1"）会向请求中注入第二个标头。
 */
function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\x00]/g, '')
}

/**
 * 使用 process.env 插值字符串中的 $VAR_NAME 和 ${VAR_NAME} 模式，但仅限于允许列表中存在的变量名。
 * 对不在允许列表中的变量的引用将被替换为空字符串，以防止通过项目配置的 HTTP 钩子泄露机密。
 *
 * 结果经过清理，去除 CR/LF/NUL 字节，以防止标头注入。
 */
function interpolateEnvVars(
  value: string,
  allowedEnvVars: ReadonlySet<string>,
): string {
  /** 执行 interpolated 对应的业务处理。 */
  const interpolated = value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (_, braced, unbraced) => {
      const varName = braced ?? unbraced
      if (!allowedEnvVars.has(varName)) {
        logForDebugging(
          `Hooks: env var $${varName} not in allowedEnvVars, skipping interpolation`,
          { level: 'warn' },
        )
        return ''
      }
      return process.env[varName] ?? ''
    },
  )
  return sanitizeHeaderValue(interpolated)
}

/**
 * 通过将钩子输入的 JSON POST 到配置的 URL 来执行 HTTP 钩子。
 * 返回原始响应以供调用方解释。
 *
 * 当启用沙箱时，请求通过沙箱网络代理路由，该代理强制执行域名允许列表。对于被阻止的域名，代理返回 HTTP 403。
 *
 * 标头值支持 $VAR_NAME 和 ${VAR_NAME} 环境变量插值，这样机密（例如 "Authorization: Bearer $MY_TOKEN"）就不会存储在 settings.json 中。
 * 仅解析钩子的 `allowedEnvVars` 数组中显式列出的环境变量；所有其他引用都被替换为空字符串。
 */
export async function execHttpHook(
  hook: HttpHook,
  _hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  statusCode?: number
  body: string
  error?: string
  aborted?: boolean
}> {
  // 在任何 I/O 之前强制执行 URL 允许列表。遵循 allowedMcpServers 语义：
  // undefined → 无限制；[] → 阻止所有；非空 → 必须匹配某个模式。
  const policy = getHttpHookPolicy()
  if (policy.allowedUrls !== undefined) {
    /** 执行 matched 对应的业务处理。 */
    const matched = policy.allowedUrls.some(p => urlMatchesPattern(hook.url, p))
    if (!matched) {
      const msg = `HTTP hook blocked: ${hook.url} does not match any pattern in allowedHttpHookUrls`
      logForDebugging(msg, { level: 'warn' })
      return { ok: false, body: '', error: msg }
    }
  }

  const timeoutMs = hook.timeout
    ? hook.timeout * 1000
    : DEFAULT_HTTP_HOOK_TIMEOUT_MS

  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(
    signal,
    { timeoutMs },
  )

  try {
    // 构建标头，值中包含环境变量插值
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (hook.headers) {
      // 当策略设置时，将钩子的 allowedEnvVars 与策略允许列表取交集
      const hookVars = hook.allowedEnvVars ?? []
      const effectiveVars =
        policy.allowedEnvVars !== undefined
          ? hookVars.filter(v => policy.allowedEnvVars!.includes(v))
          : hookVars
      const allowedEnvVars = new Set(effectiveVars)
      for (const [name, value] of Object.entries(hook.headers)) {
        headers[name] = interpolateEnvVars(value, allowedEnvVars)
      }
    }

    // 当可用时，通过沙箱网络代理路由。代理强制执行域名允许列表，并为被阻止的域名返回 403。
    const sandboxProxy = await getSandboxProxyConfig()

    // 检测环境变量代理（HTTP_PROXY / HTTPS_PROXY，尊重 NO_PROXY）。
    // 当设置时，configureGlobalAgents() 已经安装了请求拦截器，该拦截器将 httpsAgent 设置为 HttpsProxyAgent——代理处理目标服务器的 DNS。
    // 在这种情况下跳过 SSRF 防护，就像我们对沙箱代理所做的那样，以免意外阻止位于私有 IP（例如 10.0.0.1:3128）上的公司代理。
    const envProxyActive =
      !sandboxProxy &&
      getProxyUrl() !== undefined &&
      !shouldBypassProxy(hook.url)

    if (sandboxProxy) {
      logForDebugging(
        `Hooks: HTTP hook POST to ${hook.url} (via sandbox proxy :${sandboxProxy.port})`,
      )
    } else if (envProxyActive) {
      logForDebugging(
        `Hooks: HTTP hook POST to ${hook.url} (via env-var proxy)`,
      )
    } else {
      logForDebugging(`Hooks: HTTP hook POST to ${hook.url}`)
    }

    const response = await axios.post<string>(hook.url, jsonInput, {
      headers,
      signal: combinedSignal,
      responseType: 'text',
      /** 校验 validate Status 对应的数据或状态。 */
      validateStatus: () => true,
      maxRedirects: 0,
      // 显式 false 会阻止 axios 自身的环境变量代理检测；当配置了环境变量代理时，由 configureGlobalAgents() 安装的全局 axios 拦截器通过 httpsAgent 处理它。
      proxy: sandboxProxy ?? false,
      // SSRF 防护：验证解析的 IP，阻止私有/链路本地范围（但允许用于本地开发的回环地址）。当使用任何代理时跳过——代理执行目标服务器的 DNS，而应用防护会转而验证代理自身的 IP，从而中断与私有网络上的公司代理的连接。
      lookup: sandboxProxy || envProxyActive ? undefined : ssrfGuardedLookup,
    })

    cleanup()

    const body = response.data ?? ''
    logForDebugging(
      `Hooks: HTTP hook response status ${response.status}, body length ${body.length}`,
    )

    return {
      ok: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      body,
    }
  } catch (error) {
    cleanup()

    if (combinedSignal.aborted) {
      return { ok: false, body: '', aborted: true }
    }

    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: HTTP hook error: ${errorMsg}`, { level: 'error' })
    return { ok: false, body: '', error: errorMsg }
  }
}
