import { feature } from 'src/utils/features.js'
import type {
  ElicitResult,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import type { AssistantMessage } from 'src//types/message.js'
import type {
  HookInput,
  HookJSONOutput,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  SDKControlElicitationResponseSchema,
  SDKUpdateEnvironmentVariablesMessageSchema,
} from 'src/entrypoints/sdk/controlSchemas.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
  StdinMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { type HookCallback, hookJSONOutputSchema } from 'src/types/hooks.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { AbortError } from 'src/utils/errors.js'
import {
  type Output as PermissionToolOutput,
  permissionPromptToolResultToPermissionDecision,
  outputSchema as permissionToolOutputSchema,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from 'src/utils/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { writeToStdout } from 'src/utils/process.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { z } from 'zod/v4'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { executePermissionRequestHooks } from '../utils/hooks.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../utils/permissions/PermissionUpdate.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
} from '../utils/sessionState.js'
import { jsonParse } from '../utils/slowOperations.js'
import { Stream } from '../utils/stream.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'

/** 通过 can_use_tool control_request 协议转发沙箱网络权限请求时使用的合成工具名称。SDK 主机将其视为正常的工具权限提示。 */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess'

/** 格式化 serialize Decision Reason 对应的数据或状态。 */
function serializeDecisionReason(
  reason: PermissionDecisionReason | undefined,
): string | undefined {
  if (!reason) {
    return undefined
  }

  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    reason.type === 'classifier'
  ) {
    return reason.reason
  }
  switch (reason.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResults':
    case 'permissionPromptTool':
      return undefined
    case 'hook':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return reason.reason
  }
}

/** 创建 build Requires Action Details 对应的数据或状态。 */
function buildRequiresActionDetails(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseID: string,
  requestId: string,
): RequiresActionDetails {
  // 每个工具的摘要方法可能在格式错误的输入上抛出异常；权限处理不能因为描述错误而中断。
  let description: string
  try {
    description =
      tool.getActivityDescription?.(input) ??
      tool.getToolUseSummary?.(input) ??
      tool.userFacingName(input)
  } catch {
    description = tool.name
  }
  return {
    tool_name: tool.name,
    action_description: description,
    tool_use_id: toolUseID,
    request_id: requestId,
    input,
  }
}

type PendingRequest<T> = {
  /** 确定 resolve 对应的数据或状态。 */
  resolve: (result: T) => void
  /** 执行 reject 对应的业务处理。 */
  reject: (error: unknown) => void
  schema?: z.Schema
  request: SDKControlRequest
}

/** 提供一种结构化方式，通过 stdio 读写 SDK 消息，捕获 SDK 协议。 */
// 最多跟踪的已解析 tool_use ID 数量。超过后，移除最旧的条目。这在非常长的会话中限制内存，同时保留足够的历史以捕获重复的 control_response 交付。
const MAX_RESOLVED_TOOL_USE_IDS = 1000

export class StructuredIO {
  readonly structuredInput: AsyncGenerator<StdinMessage | SDKMessage>
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()

  private inputClosed = false
  /** 执行 unexpected Response Callback 对应的业务处理。 */
  private unexpectedResponseCallback?: (
    response: SDKControlResponse,
  ) => Promise<void>

  // 跟踪已通过正常权限流程（或由钩子中止）解析的 tool_use ID。当重复的 control_response 在原始响应已被处理后到达时，此 Set 防止孤儿处理程序重新处理它——否则会将重复的助手消息推入 mutableMessages，并导致 API 返回 400 错误“tool_use ids must be unique”。
  private readonly resolvedToolUseIds = new Set<string>()
  private prependedLines: string[] = []

  // sendRequest() 和 print.ts 都入队到这里；drain 循环是唯一的写入者。防止 control_request 超越已排队的 stream_events。
  readonly outbound = new Stream<StdoutMessage>()

  /** 初始化当前实例及其必要状态。 */
  constructor(
    private readonly input: AsyncIterable<string>,
    private readonly replayUserMessages?: boolean,
  ) {
    this.input = input
    this.structuredInput = this.read()
  }

  /** 记录一个 tool_use ID 为已解析，使同一工具的延迟/重复 control_response 消息被孤儿处理程序忽略。 */
  private trackResolvedToolUseId(request: SDKControlRequest): void {
    if (request.request.subtype === 'can_use_tool') {
      this.resolvedToolUseIds.add(request.request.tool_use_id)
      if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
        // 移除最旧的条目（Set 按插入顺序迭代）
        const first = this.resolvedToolUseIds.values().next().value
        if (first !== undefined) {
          this.resolvedToolUseIds.delete(first)
        }
      }
    }
  }

  /** 在从 this.input 输出下一条消息之前，排入一个用户回合。在迭代开始前和流中间都有效——read() 在每条输出的消息之间重新检查 prependedLines。 */
  prependUserMessage(content: string): void {
    this.prependedLines.push(
      jsonStringify({
        type: 'user',
        session_id: '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage) + '\n',
    )
  }

  /** 获取 read 对应的数据或状态。 */
  private async *read() {
    let content = ''

    // 在 for-await 之前调用一次（空的 this.input 否则完全跳过循环体），然后每块再调用一次。prependedLines 的重新检查在 while 内部，因此在同一块的两条消息之间推入的 prepend 仍然会先出现。
    const splitAndProcess = async function* (this: StructuredIO) {
      for (;;) {
        if (this.prependedLines.length > 0) {
          content = this.prependedLines.join('') + content
          this.prependedLines = []
        }
        const newline = content.indexOf('\n')
        if (newline === -1) break
        const line = content.slice(0, newline)
        content = content.slice(newline + 1)
        const message = await this.processLine(line)
        if (message) {
          logForDiagnosticsNoPII('info', 'cli_stdin_message_parsed', {
            type: message.type,
          })
          yield message
        }
      }
    }.bind(this)

    yield* splitAndProcess()

    for await (const block of this.input) {
      content += block
      yield* splitAndProcess()
    }
    if (content) {
      const message = await this.processLine(content)
      if (message) {
        yield message
      }
    }
    this.inputClosed = true
    for (const request of this.pendingRequests.values()) {
      // 如果输入流，则拒绝所有挂起的请求
      request.reject(
        new Error('Tool permission stream closed before response received'),
      )
    }
  }

  /** 获取 get Pending Permission Requests 对应的数据或状态。 */
  getPendingPermissionRequests() {
    return Array.from(this.pendingRequests.values())
      .map(entry => entry.request)
      .filter(pr => pr.request.subtype === 'can_use_tool')
  }

  /** 设置并保存 set Unexpected Response Callback 对应的数据或状态。 */
  setUnexpectedResponseCallback(
    callback: (response: SDKControlResponse) => Promise<void>,
  ): void {
    this.unexpectedResponseCallback = callback
  }

  /** 处理 process Line 对应的数据或状态。 */
  private async processLine(
    line: string,
  ): Promise<StdinMessage | SDKMessage | undefined> {
    // 跳过空行（例如来自管道标准输入中的双换行）
    if (!line) {
      return undefined
    }
    try {
      const message = normalizeControlMessageKeys(jsonParse(line)) as
        | StdinMessage
        | SDKMessage
      if (message.type === 'keep_alive') {
        // 静默忽略 keep-alive 消息
        return undefined
      }
      if (message.type === 'update_environment_variables') {
        // 将环境变量更新直接应用于 process.env。SDK 主机可以在不重启进程的情况下更新提供者凭据；子工具进程稍后会收到相同的环境。
        const environmentUpdate =
          SDKUpdateEnvironmentVariablesMessageSchema().parse(message)
        const keys = Object.keys(environmentUpdate.variables)
        for (const [key, value] of Object.entries(environmentUpdate.variables)) {
          process.env[key] = value
        }
        logForDebugging(
          `[structuredIO] applied update_environment_variables: ${keys.join(', ')}`,
        )
        return undefined
      }
      if (message.type === 'control_response') {
        // 对每个 control_response 关闭生命周期，包括重复和孤儿——孤儿不会产生到 print.ts 主循环，因此这是唯一能看到它们的路径。uuid 是由服务器注入到负载中的。
        const uuid =
          'uuid' in message && typeof message.uuid === 'string'
            ? message.uuid
            : undefined
        if (uuid) {
          notifyCommandLifecycle(uuid, 'completed')
        }
        const request = this.pendingRequests.get(message.response.request_id)
        if (!request) {
          // 检查此 tool_use 是否已通过正常权限流程解析。重复的 control_response 交付（例如来自 WebSocket 重连）在原始响应被处理后到达，重新处理它们会将重复的助手消息推入对话，导致 API 400 错误。
          const responsePayload =
            message.response.subtype === 'success'
              ? message.response.response
              : undefined
          const toolUseID = responsePayload?.toolUseID
          if (
            typeof toolUseID === 'string' &&
            this.resolvedToolUseIds.has(toolUseID)
          ) {
            logForDebugging(
              `Ignoring duplicate control_response for already-resolved toolUseID=${toolUseID} request_id=${message.response.request_id}`,
            )
            return undefined
          }
          if (this.unexpectedResponseCallback) {
            await this.unexpectedResponseCallback(message)
          }
          return undefined // 忽略我们不认识的请求的响应
        }
        this.trackResolvedToolUseId(request.request)
        this.pendingRequests.delete(message.response.request_id)
        if (message.response.subtype === 'error') {
          request.reject(new Error(message.response.error))
          return undefined
        }
        const result = message.response.response
        if (request.schema) {
          try {
            request.resolve(request.schema.parse(result))
          } catch (error) {
            request.reject(error)
          }
        } else {
          request.resolve({})
        }
        // 启用重放时传播控制响应
        if (this.replayUserMessages) {
          return message
        }
        return undefined
      }
      if (
        message.type !== 'user' &&
        message.type !== 'control_request' &&
        message.type !== 'assistant' &&
        message.type !== 'system'
      ) {
        logForDebugging(`Ignoring unknown message type: ${message.type}`, {
          level: 'warn',
        })
        return undefined
      }
      if (message.type === 'control_request') {
        if (!message.request) {
          exitWithMessage(`Error: Missing request on control_request`)
        }
        return message
      }
      if (message.type === 'assistant' || message.type === 'system') {
        return message
      }
      if (message.message.role !== 'user') {
        exitWithMessage(
          `Error: Expected message role 'user', got '${message.message.role}'`,
        )
      }
      return message
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error parsing streaming input line: ${line}: ${error}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  /** 设置并保存 write 对应的数据或状态。 */
  async write(message: StdoutMessage): Promise<void> {
    writeToStdout(ndjsonSafeStringify(message) + '\n')
  }

  /** 输出或发送 send Request 对应的数据或状态。 */
  private async sendRequest<Response>(
    request: SDKControlRequest['request'],
    schema: z.Schema,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<Response> {
    const message: SDKControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request,
    }
    if (this.inputClosed) {
      throw new Error('Stream closed')
    }
    if (signal?.aborted) {
      throw new Error('Request aborted')
    }
    this.outbound.enqueue(message)
    /** 停止或关闭 aborted 对应的数据或状态。 */
    const aborted = () => {
      this.outbound.enqueue({
        type: 'control_cancel_request',
        request_id: requestId,
      })
      // 立即拒绝未完成的 promise，无需等待主机确认取消。
      const request = this.pendingRequests.get(requestId)
      if (request) {
        // 在拒绝之前将 tool_use ID 标记为已解析，从而使来自主机的延迟响应被孤儿处理程序忽略。
        this.trackResolvedToolUseId(request.request)
        request.reject(new AbortError())
      }
    }
    if (signal) {
      signal.addEventListener('abort', aborted, {
        once: true,
      })
    }
    try {
      return await new Promise<Response>((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          request: {
            type: 'control_request',
            request_id: requestId,
            request,
          },
          /** 确定 resolve 对应的数据或状态。 */
          resolve: result => {
            resolve(result as Response)
          },
          reject,
          schema,
        })
      })
    } finally {
      if (signal) {
        signal.removeEventListener('abort', aborted)
      }
      this.pendingRequests.delete(requestId)
    }
  }

  /** 创建 create Can Use Tool 对应的数据或状态。 */
  createCanUseTool(
    onPermissionPrompt?: (details: RequiresActionDetails) => void,
  ): CanUseToolFn {
    return async (
      tool: Tool,
      input: { [key: string]: unknown },
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: PermissionDecision,
    ): Promise<PermissionDecision> => {
      const mainPermissionResult =
        forceDecision ??
        (await hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ))
      // 如果工具被允许或拒绝，返回结果
      if (
        mainPermissionResult.behavior === 'allow' ||
        mainPermissionResult.behavior === 'deny'
      ) {
        return mainPermissionResult
      }

      // 并行运行 PermissionRequest 钩子和 SDK 权限提示。在终端 CLI 中，钩子与交互式提示竞争，以便例如带有 --delay 20 的钩子不会阻塞 UI。我们在这里需要相同的行为：SDK 主机（VS Code 等）立即显示其权限对话框，而钩子在后台运行。先解析的获胜；失败的被取消/忽略。

      // 用于在钩子先决定时取消 SDK 请求的 AbortController
      const hookAbortController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      // 将父级中止转发到我们的本地控制器
      const onParentAbort = () => hookAbortController.abort()
      parentSignal.addEventListener('abort', onParentAbort, { once: true })

      try {
        // 开始钩子评估（后台运行）
        const hookPromise = executePermissionRequestHooksForSDK(
          tool.name,
          toolUseID,
          input,
          toolUseContext,
          mainPermissionResult.suggestions,
        ).then(decision => ({ source: 'hook' as const, decision }))

        // 立即启动 SDK 权限提示（不等待钩子）
        const requestId = randomUUID()
        onPermissionPrompt?.(
          buildRequiresActionDetails(tool, input, toolUseID, requestId),
        )
        /** 执行 sdk Promise 对应的业务处理。 */
        const sdkPromise = this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: tool.name,
            input,
            permission_suggestions: mainPermissionResult.suggestions,
            blocked_path: mainPermissionResult.blockedPath,
            decision_reason: serializeDecisionReason(
              mainPermissionResult.decisionReason,
            ),
            tool_use_id: toolUseID,
            agent_id: toolUseContext.agentId,
          },
          permissionToolOutputSchema(),
          hookAbortController.signal,
          requestId,
        ).then(result => ({ source: 'sdk' as const, result }))

        // 竞态：钩子完成 vs SDK 提示响应。
        // 钩子 promise 始终解析（从不拒绝），若无钩子做出决定则返回 undefined。
        const winner = await Promise.race([hookPromise, sdkPromise])

        if (winner.source === 'hook') {
          if (winner.decision) {
            // 钩子已决定 — 中止待处理的 SDK 请求。
            // 抑制 sdkPromise 预期的 AbortError 拒绝。
            sdkPromise.catch(() => {})
            hookAbortController.abort()
            return winner.decision
          }
          // 钩子未做决定（未处理）— 等待 SDK 提示
          const sdkResult = await sdkPromise
          return permissionPromptToolResultToPermissionDecision(
            sdkResult.result,
            tool,
            input,
            toolUseContext,
          )
        }

        // SDK 提示先响应 — 使用其结果（钩子仍在后台运行，但其结果将被忽略）
        return permissionPromptToolResultToPermissionDecision(
          winner.result,
          tool,
          input,
          toolUseContext,
        )
      } catch (error) {
        return permissionPromptToolResultToPermissionDecision(
          {
            behavior: 'deny',
            message: `Tool permission request failed: ${error}`,
            toolUseID,
          },
          tool,
          input,
          toolUseContext,
        )
      } finally {
        // 仅在没有其他待处理的权限提示时才能转换回 'running' 状态（并发工具执行可能有多个进行中的提示）。
        if (this.getPendingPermissionRequests().length === 0) {
          notifySessionStateChanged('running')
        }
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  /** 创建 create Hook Callback 对应的数据或状态。 */
  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
      timeout,
      /** 执行 callback 对应的数据或状态。 */
      callback: async (
        input: HookInput,
        toolUseID: string | null,
        abort: AbortSignal | undefined,
      ): Promise<HookJSONOutput> => {
        try {
          const result = await this.sendRequest<HookJSONOutput>(
            {
              subtype: 'hook_callback',
              callback_id: callbackId,
              input,
              tool_use_id: toolUseID || undefined,
            },
            hookJSONOutputSchema(),
            abort,
          )
          return result
        } catch (error) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(`Error in hook callback ${callbackId}:`, error)
          return {}
        }
      },
    }
  }

  /** 向 SDK 消费者发送查询请求并返回响应。 */
  async handleElicitation(
    serverName: string,
    message: string,
    requestedSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    mode?: 'form' | 'url',
    url?: string,
    elicitationId?: string,
  ): Promise<ElicitResult> {
    try {
      const result = await this.sendRequest<ElicitResult>(
        {
          subtype: 'elicitation',
          mcp_server_name: serverName,
          message,
          mode,
          url,
          elicitation_id: elicitationId,
          requested_schema: requestedSchema,
        },
        SDKControlElicitationResponseSchema(),
        signal,
      )
      return result
    } catch {
      return { action: 'cancel' as const }
    }
  }

  /**
   * 创建 SandboxAskCallback，将沙箱网络权限请求作为 can_use_tool 的 control_requests 转发给 SDK 主机。
   * 这借用了现有的 can_use_tool 协议，通过合成方式实现网络访问，无需新的协议子类型。
   */
  createSandboxAskCallback(): (hostPattern: {
    host: string
    port?: number
  }) => Promise<boolean> {
    return async (hostPattern): Promise<boolean> => {
      try {
        const result = await this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            input: { host: hostPattern.host },
            tool_use_id: randomUUID(),
            description: `Allow network connection to ${hostPattern.host}?`,
          },
          permissionToolOutputSchema(),
        )
        return result.behavior === 'allow'
      } catch {
        // 如果请求失败（流关闭、中止等），拒绝连接
        return false
      }
    }
  }

  /** 向 SDK 服务器发送 MCP 消息并等待响应 */
  async sendMcpMessage(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> {
    const response = await this.sendRequest<{ mcp_response: JSONRPCMessage }>(
      {
        subtype: 'mcp_message',
        server_name: serverName,
        message,
      },
      z.object({
        mcp_response: z.any() as z.Schema<JSONRPCMessage>,
      }),
    )
    return response.mcp_response
  }
}

/** 执行 exit With Message 对应的业务处理。 */
function exitWithMessage(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * 执行 PermissionRequest 钩子，如果做出决定则返回该决定。
 * 如果没有任何钩子做出决定，则返回 undefined。
 */
async function executePermissionRequestHooksForSDK(
  toolName: string,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | undefined> {
  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode

  // 直接在生成器上进行迭代，而不是使用 `all`
  const hookGenerator = executePermissionRequestHooks(
    toolName,
    toolUseID,
    input,
    toolUseContext,
    permissionMode,
    suggestions,
    toolUseContext.abortController.signal,
  )

  for await (const hookResult of hookGenerator) {
    if (
      hookResult.permissionRequestResult &&
      (hookResult.permissionRequestResult.behavior === 'allow' ||
        hookResult.permissionRequestResult.behavior === 'deny')
    ) {
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        const finalInput = decision.updatedInput || input

        // 如果钩子提供了权限更新（"始终允许"），则应用更新
        const permissionUpdates = decision.updatedPermissions ?? []
        if (permissionUpdates.length > 0) {
          persistPermissionUpdates(permissionUpdates)
          const currentAppState = toolUseContext.getAppState()
          const updatedContext = applyPermissionUpdates(
            currentAppState.toolPermissionContext,
            permissionUpdates,
          )
          // 通过 setAppState 更新权限上下文
          toolUseContext.setAppState(prev => {
            if (prev.toolPermissionContext === updatedContext) return prev
            return { ...prev, toolPermissionContext: updatedContext }
          })
        }

        return {
          behavior: 'allow',
          updatedInput: finalInput,
          userModified: false,
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      } else {
        // 钩子拒绝了权限
        return {
          behavior: 'deny',
          message:
            decision.message || 'Permission denied by PermissionRequest hook',
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      }
    }
  }

  return undefined
}
