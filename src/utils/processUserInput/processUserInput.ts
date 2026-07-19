import { feature } from 'src/utils/features.js'
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import type { QuerySource } from 'src/constants/querySource.js'
import { getContentText } from 'src/utils/messages.js'
import { type LocalJSXCommandContext } from '../../commands.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  isValidImagePaste,
  type PromptInputMode,
} from '../../types/textInputTypes.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import type { PastedContent } from '../config.js'
import type { EffortValue } from '../effort.js'
import { toArray } from '../generators.js'
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from '../hooks.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBlock,
} from '../imageResizer.js'
import { storeImages } from '../imageStore.js'
import {
  createCommandInputMessage,
  createSystemMessage,
  createUserMessage,
} from '../messages.js'
import { queryCheckpoint } from '../queryProfiler.js'
import { getSessionId } from '../../bootstrap/state.js'
import { saveCustomTitle } from '../sessionStorage.js'
import { processTextPrompt } from './processTextPrompt.js'
export type ProcessUserInputContext = ToolUseContext & LocalJSXCommandContext

export type ProcessUserInputBaseResult = {
  messages: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
    | ProgressMessage
  )[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  // 非交互模式（如派生的命令）的输出文本
  // 设置后，在 -p 模式下将以此结果代替空字符串
  resultText?: string
  // 设置后，在命令完成后预填或提交下一个输入
  // 由 /discover 用于链入选定功能的命令
  nextInput?: string
  submitNextInput?: boolean
}

/** 处理 process User Input 对应的数据或状态。 */
export async function processUserInput({
  input,
  preExpansionInput,
  mode,
  setToolJSX,
  context,
  pastedContents,
  ideSelection,
  messages,
  setUserInputOnProcessing,
  uuid,
  isAlreadyProcessing,
  querySource,
  canUseTool,
  skipSlashCommands,
  isMeta,
  skipAttachments,
}: {
  input: string | Array<ContentBlockParam>
  /** 粘贴内容占位符展开前的输入。 */
  preExpansionInput?: string
  mode: PromptInputMode
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection
  messages?: Message[]
  /** 设置并保存 set User Input On Processing 对应的数据或状态。 */
  setUserInputOnProcessing?: (prompt?: string) => void
  uuid?: string
  isAlreadyProcessing?: boolean
  querySource?: QuerySource
  canUseTool?: CanUseToolFn
  /**
   * 为 true 时，以 `/` 开头的输入被视为纯文本。
   * 用于不应触发本地斜杠命令的注入消息。
   */
  skipSlashCommands?: boolean
  /**
   * 为 true 时，生成的 UserMessage 标记 `isMeta: true`（用户隐藏，模型可见）。
   * 从 QueuedCommand.isMeta 传播，用于队列中的系统生成提示。
   */
  isMeta?: boolean
  skipAttachments?: boolean
}): Promise<ProcessUserInputBaseResult> {
  const inputString = typeof input === 'string' ? input : null
  // 在仍在处理输入时立即显示用户输入提示。
  // 对于 isMeta（系统生成的提示，如定时任务）跳过——这些应不可见地运行。
  if (mode === 'prompt' && inputString !== null && !isMeta) {
    setUserInputOnProcessing?.(inputString)
  }

  queryCheckpoint('query_process_user_input_base_start')

  const appState = context.getAppState()

  const result = await processUserInputBase(
    input,
    mode,
    setToolJSX,
    context,
    pastedContents,
    ideSelection,
    messages,
    uuid,
    isAlreadyProcessing,
    querySource,
    canUseTool,
    appState.toolPermissionContext.mode,
    skipSlashCommands,
    isMeta,
    skipAttachments,
    preExpansionInput,
  )
  queryCheckpoint('query_process_user_input_base_end')

  if (!result.shouldQuery) {
    return result
  }

  // 执行 UserPromptSubmit 钩子并处理阻塞
  queryCheckpoint('query_hooks_start')
  const inputMessage = getContentText(input) || ''

  for await (const hookResult of executeUserPromptSubmitHooks(
    inputMessage,
    appState.toolPermissionContext.mode,
    context,
    context.requestPrompt,
  )) {
    // 我们只关心结果
    if (hookResult.message?.type === 'progress') {
      continue
    }

    // 仅返回系统级错误消息，删除原始用户输入
    if (hookResult.blockingError) {
      const blockingMessage = getUserPromptSubmitHookBlockingMessage(
        hookResult.blockingError,
      )
      return {
        messages: [
          // TODO: 使其成为附件消息
          createSystemMessage(
            `${blockingMessage}\n\nOriginal prompt: ${input}`,
            'warning',
          ),
        ],
        shouldQuery: false,
        allowedTools: result.allowedTools,
      }
    }

    // 如果设置了 preventContinuation，则停止处理但保留原始提示在上下文中。
    if (hookResult.preventContinuation) {
      const message = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : 'Operation stopped by hook'
      result.messages.push(
        createUserMessage({
          content: message,
        }),
      )
      result.shouldQuery = false
      return result
    }

    // 钩子可在提交提示词时更新当前会话标题；持久化后缓存会立即同步，供界面读取。
    if (hookResult.sessionTitle) {
      await saveCustomTitle(
        getSessionId() as UUID,
        hookResult.sessionTitle,
        undefined,
        'auto',
      )
    }

    // 收集额外的上下文
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      result.messages.push(
        createAttachmentMessage({
          type: 'hook_additional_context',
          content: hookResult.additionalContexts.map(applyTruncation),
          hookName: 'UserPromptSubmit',
          toolUseID: `hook-${randomUUID()}`,
          hookEvent: 'UserPromptSubmit',
        }),
      )
    }

    // TODO: 清理此代码
    if (hookResult.message) {
      switch (hookResult.message.attachment.type) {
        case 'hook_success':
          if (!hookResult.message.attachment.content) {
            // 如果没有内容则跳过
            break
          }
          result.messages.push({
            ...hookResult.message,
            attachment: {
              ...hookResult.message.attachment,
              content: applyTruncation(hookResult.message.attachment.content),
            },
          })
          break
        default:
          result.messages.push(hookResult.message)
          break
      }
    }
  }
  queryCheckpoint('query_hooks_end')

  // 理想路径：onQuery 通过 startTransition 清除 userInputOnProcessing，
  // 因此与 deferredMessages 在同一帧中解析（无闪烁间隙）。
  // 错误路径由 handlePromptSubmit 的 finally 块处理。
  return result
}

const MAX_HOOK_OUTPUT_LENGTH = 10000

/** 执行 apply Truncation 对应的业务处理。 */
function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`
  }
  return content
}

/** 处理 process User Input Base 对应的数据或状态。 */
async function processUserInputBase(
  input: string | Array<ContentBlockParam>,
  mode: PromptInputMode,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  pastedContents?: Record<number, PastedContent>,
  ideSelection?: IDESelection,
  messages?: Message[],
  uuid?: string,
  isAlreadyProcessing?: boolean,
  querySource?: QuerySource,
  canUseTool?: CanUseToolFn,
  permissionMode?: PermissionMode,
  skipSlashCommands?: boolean,
  isMeta?: boolean,
  skipAttachments?: boolean,
  preExpansionInput?: string,
): Promise<ProcessUserInputBaseResult> {
  let inputString: string | null = null
  let precedingInputBlocks: ContentBlockParam[] = []

  // 为 isMeta 消息收集图片元数据文本
  const imageMetadataTexts: string[] = []

  // 带有图片块调整大小后的 `input` 归一化视图。对于字符串输入，
  // 这只是 `input`；对于数组输入，它是处理后的块。我们将此（而非原始 `input`）
  // 传递给 processTextPrompt，以便调整大小/归一化的图片块实际到达 API——
  // 否则上述调整大小的工作对于常规提示路径会被丢弃。同时归一化桥接输入，
  // 其中 iOS 可能发送 `mediaType` 而非 `media_type`（mobile-apps#5825）。
  let normalizedInput: string | ContentBlockParam[] = input

  if (typeof input === 'string') {
    inputString = input
  } else if (input.length > 0) {
    queryCheckpoint('query_image_processing_start')
    const processedBlocks: ContentBlockParam[] = []
    for (const block of input) {
      if (block.type === 'image') {
        const resized = await maybeResizeAndDownsampleImageBlock(block)
        // 为 isMeta 消息收集图片元数据
        if (resized.dimensions) {
          const metadataText = createImageMetadataText(resized.dimensions)
          if (metadataText) {
            imageMetadataTexts.push(metadataText)
          }
        }
        processedBlocks.push(resized.block)
      } else {
        processedBlocks.push(block)
      }
    }
    normalizedInput = processedBlocks
    queryCheckpoint('query_image_processing_end')
    // 如果最后一个内容块是文本，从中提取输入字符串，并跟踪前面的内容块
    const lastBlock = processedBlocks[processedBlocks.length - 1]
    if (lastBlock?.type === 'text') {
      inputString = lastBlock.text
      precedingInputBlocks = processedBlocks.slice(0, -1)
    } else {
      precedingInputBlocks = processedBlocks
    }
  }

  if (inputString === null && mode !== 'prompt') {
    throw new Error(`Mode: ${mode} requires a string input.`)
  }

  // 尽早提取图片内容并转换为内容块
  // 按顺序跟踪 ID 以便消息存储
  const imageContents = pastedContents
    ? Object.values(pastedContents).filter(isValidImagePaste)
    : []
  /** 执行 image Paste Ids 对应的业务处理。 */
  const imagePasteIds = imageContents.map(img => img.id)

  // 将图片存储到磁盘，以便 Claude 可以在上下文中引用路径
  // （用于通过 CLI 工具操作、上传到 PR 等）
  const storedImagePaths = pastedContents
    ? await storeImages(pastedContents)
    : new Map<number, string>()

  // 调整粘贴图片的大小以确保符合 API 限制（并行处理）
  queryCheckpoint('query_pasted_image_processing_start')
  const imageProcessingResults = await Promise.all(
    imageContents.map(async pastedImage => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (pastedImage.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: pastedImage.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return {
        resized,
        originalDimensions: pastedImage.dimensions,
        sourcePath:
          pastedImage.sourcePath ?? storedImagePaths.get(pastedImage.id),
      }
    }),
  )
  // 收集结果，保持顺序
  const imageContentBlocks: ContentBlockParam[] = []
  for (const {
    resized,
    originalDimensions,
    sourcePath,
  } of imageProcessingResults) {
    // 为 isMeta 消息收集图片元数据（优先使用调整后的尺寸）
    if (resized.dimensions) {
      const metadataText = createImageMetadataText(
        resized.dimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (originalDimensions) {
      // 如果 resize 没有提供尺寸，则回退到原始尺寸
      const metadataText = createImageMetadataText(
        originalDimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (sourcePath) {
      // 如果有源路径但没有尺寸，仍然添加源信息
      imageMetadataTexts.push(`[Image source: ${sourcePath}]`)
    }
    imageContentBlocks.push(resized.block)
  }
  queryCheckpoint('query_pasted_image_processing_end')

  // 对于斜杠命令，附件将在 getMessagesForSlashCommand 中提取
  const shouldExtractAttachments =
    !skipAttachments &&
    inputString !== null &&
    (mode !== 'prompt' || skipSlashCommands || !inputString.startsWith('/'))

  queryCheckpoint('query_attachment_loading_start')
  const attachmentMessages = shouldExtractAttachments
    ? await toArray(
        getAttachmentMessages(
          inputString,
          context,
          ideSelection ?? null,
          [], // queuedCommands - handled by query.ts for mid-turn attachments
          messages,
          querySource,
        ),
      )
    : []
  queryCheckpoint('query_attachment_loading_end')

  // Bash 命令
  if (inputString !== null && mode === 'bash') {
    const { processBashCommand } = await import('./processBashCommand.js')
    return addImageMetadataMessage(
      await processBashCommand(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        context,
        setToolJSX,
      ),
      imageMetadataTexts,
    )
  }

  // 斜杠命令
  if (
    inputString !== null &&
    !skipSlashCommands &&
    inputString.startsWith('/')
  ) {
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      inputString,
      precedingInputBlocks,
      imageContentBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // 常规用户提示
  return addImageMetadataMessage(
    processTextPrompt(
      normalizedInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid,
      permissionMode,
      isMeta,
    ),
    imageMetadataTexts,
  )
}

// 将图像元数据文本作为 isMeta 消息添加到结果中
function addImageMetadataMessage(
  result: ProcessUserInputBaseResult,
  imageMetadataTexts: string[],
): ProcessUserInputBaseResult {
  if (imageMetadataTexts.length > 0) {
    result.messages.push(
      createUserMessage({
        /** 执行 content 对应的业务处理。 */
        content: imageMetadataTexts.map(text => ({ type: 'text', text })),
        isMeta: true,
      }),
    )
  }
  return result
}
