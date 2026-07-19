import { randomUUID } from 'crypto'
import { getSdkBetas, getSessionId } from 'src/bootstrap/state.js'
import { DEFAULT_OUTPUT_STYLE_NAME } from 'src/constants/outputStyles.js'
import type {
  ApiKeySource,
  PermissionMode,
  SDKMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  getAnthropicApiKeyWithSource,
  type ApiKeySource as CredentialApiKeySource,
} from '../auth.js'
import { getCwd } from '../cwd.js'
import { getFastModeState } from '../fastMode.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../settings/settings.js'

/**
 * 将本框架的 API Key 来源映射为公共 Agent SDK 的来源枚举。
 *
 * 环境变量和无本地密钥的云提供商认证都属于临时运行时凭据；API Key Helper
 * 则按其配置层级映射。该函数绝不会返回 `oauth`，因为 Claude 账号登录链路已移除。
 */
export function toSdkApiKeySource(
  source: CredentialApiKeySource,
): Exclude<ApiKeySource, 'oauth'> {
  if (source !== 'apiKeyHelper') {
    return 'temporary'
  }
  if (getSettingsForSource('policySettings')?.apiKeyHelper) {
    return 'org'
  }
  if (
    getSettingsForSource('projectSettings')?.apiKeyHelper ||
    getSettingsForSource('localSettings')?.apiKeyHelper
  ) {
    return 'project'
  }
  if (getSettingsForSource('userSettings')?.apiKeyHelper) {
    return 'user'
  }
  return 'temporary'
}

type CommandLike = { name: string; userInvocable?: boolean }

export type SystemInitInputs = {
  tools: ReadonlyArray<{ name: string }>
  mcpClients: ReadonlyArray<{ name: string; type: string }>
  model: string
  permissionMode: PermissionMode
  commands: ReadonlyArray<CommandLike>
  agents: ReadonlyArray<{ agentType: string }>
  skills: ReadonlyArray<CommandLike>
  plugins: ReadonlyArray<{ name: string; path: string; source: string }>
  fastMode: boolean | undefined
}

/**
 * 构建 SDK 流中的第一条 `system/init` 消息，携带工作目录、工具、模型和命令等
 * 会话元数据，供远端客户端渲染选择器并控制界面能力。
 *
 * 所有调用路径必须生成完全相同的消息结构，避免交互模式和无界面模式的协议漂移。
 */
export function buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage {
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  const initMessage: SDKMessage = {
    type: 'system',
    subtype: 'init',
    cwd: getCwd(),
    session_id: getSessionId(),
    tools: inputs.tools.map(tool => tool.name),
    /** 执行 mcp servers 对应的业务处理。 */
    mcp_servers: inputs.mcpClients.map(client => ({
      name: client.name,
      status: client.type,
    })),
    model: inputs.model,
    permissionMode: inputs.permissionMode,
    /** 执行 slash commands 对应的业务处理。 */
    slash_commands: inputs.commands
      .filter(c => c.userInvocable !== false)
      .map(c => c.name),
    apiKeySource: toSdkApiKeySource(
      getAnthropicApiKeyWithSource().source,
    ),
    betas: getSdkBetas(),
    claude_code_version: MACRO.VERSION,
    output_style: outputStyle,
    /** 执行 agents 对应的业务处理。 */
    agents: inputs.agents.map(agent => agent.agentType),
    /** 执行 skills 对应的业务处理。 */
    skills: inputs.skills
      .filter(s => s.userInvocable !== false)
      .map(skill => skill.name),
    /** 执行 plugins 对应的业务处理。 */
    plugins: inputs.plugins.map(plugin => ({
      name: plugin.name,
      path: plugin.path,
      source: plugin.source,
    })),
    uuid: randomUUID(),
  }
  initMessage.fast_mode_state = getFastModeState(inputs.model, inputs.fastMode)
  return initMessage
}
