import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type React from 'react'
import type { PermissionResult } from '../entrypoints/agentSdkTypes.js'
import type { Key } from '../ink.js'
import type { PastedContent } from '../utils/config.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
import type { AgentId } from './ids.js'
import type { AssistantMessage, MessageOrigin } from './message.js'

/** 用于中间输入命令自动补全的内联幽灵文本 */
export type InlineGhostText = {
  /** 要显示的幽灵文本（例如，对于 /commit 显示 "mit"） */
  readonly text: string
  /** 完整命令名称（例如 "commit"） */
  readonly fullCommand: string
  /** 幽灵文本应在输入中出现的位置 */
  readonly insertPosition: number
}

/** 文本输入组件的基础属性 */
export type BaseTextInputProps = {
  /** 可选回调，用于在输入开头按上箭头时处理历史导航 */
  readonly onHistoryUp?: () => void

  /** 可选回调，用于在输入结尾按下箭头时处理历史导航 */
  readonly onHistoryDown?: () => void

  /** 当 `value` 为空时显示的文本。 */
  readonly placeholder?: string

  /** 允许通过反斜杠结尾实现多行输入（默认：`true`） */
  readonly multiline?: boolean

  /** 监听用户输入。当同时存在多个输入组件且输入必须被“路由”到特定组件时很有用。 */
  readonly focus?: boolean

  /** 替换所有字符并掩盖值。用于密码输入。 */
  readonly mask?: string

  /** 是否显示光标并允许使用箭头键在文本输入内导航。 */
  readonly showCursor?: boolean

  /** 高亮粘贴的文本 */
  readonly highlightPastedText?: boolean

  /** 要在文本输入中显示的值。 */
  readonly value: string

  /** 值更新时调用的函数。 */
  readonly onChange: (value: string) => void

  /** 当按下 `Enter` 时调用的函数，第一个参数是输入的值。 */
  readonly onSubmit?: (value: string) => void

  /** 当按下 Ctrl+C 退出时调用的函数。 */
  readonly onExit?: () => void

  /** 可选回调，用于显示退出消息 */
  readonly onExitMessage?: (show: boolean, key?: string) => void

  /** 可选回调，用于重置历史位置 */
  readonly onHistoryReset?: () => void

  /** 当输入被清除时（例如双击 Escape）的可选回调 */
  readonly onClearInput?: () => void

  /** 文本换行的列数 */
  readonly columns: number

  /** 输入视口的最大可见行数。当换行输入超过此行数时，仅渲染光标周围的行。 */
  readonly maxVisibleLines?: number

  /** 粘贴图片时的可选回调 */
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void

  /** 粘贴大段文本（超过800字符）时的可选回调 */
  readonly onPaste?: (text: string) => void

  /** 粘贴状态变化时的回调 */
  readonly onIsPastingChange?: (isPasting: boolean) => void

  /** 是否禁用上/下方向键的光标移动 */
  readonly disableCursorMovementForUpDownKeys?: boolean

  /**
   * 跳过文本级的双击转义处理程序。当按键绑定上下文（例如自动补全）拥有转义键时设置此项——按键绑定的 stopImmediatePropagation 无法屏蔽文本输入，因为子级效果会在父级效果之前注册 useInput 监听器。
   */
  readonly disableEscapeDoublePress?: boolean

  /** 光标在文本中的偏移量 */
  readonly cursorOffset: number

  /** 设置光标偏移量的回调 */
  onChangeCursorOffset: (offset: number) => void

  /**
   * 命令输入后显示的可选提示文本
   * 用于显示命令的可用参数
   */
  readonly argumentHint?: string

  /** 撤销功能的可选回调 */
  readonly onUndo?: () => void

  /** 是否以暗淡颜色渲染文本 */
  readonly dimColor?: boolean

  /** 用于搜索结果或其他高亮的可选文本高亮 */
  readonly highlights?: TextHighlight[]

  /**
   * 可选的自定义 React 元素作为占位符渲染。
   * 提供时，会覆盖标准的 `placeholder` 字符串渲染。
   */
  readonly placeholderElement?: React.ReactNode

  /** 可选的行内幽灵文本，用于输入中途的命令自动补全 */
  readonly inlineGhostText?: InlineGhostText

  /** 在按键路由前应用于原始输入的可选过滤器。返回（可能经过转换的）输入字符串；对于非空输入返回 '' 会丢弃该事件。 */
  readonly inputFilter?: (input: string, key: Key) => string
}

/** VimTextInput 的扩展属性 */
export type VimTextInputProps = BaseTextInputProps & {
  /** 要使用的初始 Vim 模式 */
  readonly initialMode?: VimMode

  /** 模式变化时的可选回调 */
  readonly onModeChange?: (mode: VimMode) => void
}

/** Vim 编辑器模式 */
export type VimMode = 'INSERT' | 'NORMAL'

/** 输入挂钩结果的公共属性 */
export type BaseInputState = {
  /** 处理 on Input 对应的数据或状态。 */
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  /** 设置并保存 set Offset 对应的数据或状态。 */
  setOffset: (offset: number) => void
  /** 渲染文本中的光标行（从0开始），考虑换行。 */
  cursorLine: number
  /** 当前行中的光标列（显示宽度）。 */
  cursorColumn: number
  /** 视口起始位置在整个文本中的字符偏移量（无窗口时为0）。 */
  viewportCharOffset: number
  /** 视口结束位置在整个文本中的字符偏移量（无窗口时为 text.length）。 */
  viewportCharEnd: number

  // 用于处理粘贴
  isPasting?: boolean
  pasteState?: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
}

/** 文本输入的状态 */
export type TextInputState = BaseInputState

/** 带模式的vim输入的状态 */
export type VimInputState = BaseInputState & {
  mode: VimMode
  /** 设置并保存 set Mode 对应的数据或状态。 */
  setMode: (mode: VimMode) => void
}

/** 提示符的输入模式 */
export type PromptInputMode =
  | 'bash'
  | 'prompt'
  | 'orphaned-permission'
  | 'task-notification'

export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>

/**
 * 队列优先级级别。在普通模式和主动模式下语义相同。
 *
 *  - `now`   — 中断并立即发送。中止任何正在进行的工具调用（相当于 Esc + 发送）。消费者（print.ts、REPL.tsx）订阅队列变更，并在看到 'now' 命令时中止。
 *  - `next`  — 回合中排空。让当前工具调用完成，然后在工具结果和下一次 API 往返之间发送此消息。唤醒正在进行的 SleepTool 调用。
 *  - `later` — 回合结束排空。等待当前回合完成，然后作为新查询处理。唤醒正在进行的 SleepTool 调用（query.ts 在睡眠后提升排空阈值，以便消息附加到同一回合）。
 *
 * SleepTool 仅在主动模式下可用，因此在普通模式下“唤醒 SleepTool”是无操作。
 */
export type QueuePriority = 'now' | 'next' | 'later'

/** 排队的命令类型 */
export type QueuedCommand = {
  value: string | Array<ContentBlockParam>
  mode: PromptInputMode
  /** 入队时默认为 `mode` 所隐含的优先级。 */
  priority?: QueuePriority
  uuid?: UUID
  orphanedPermission?: OrphanedPermission
  /** 原始粘贴内容，包括图像。图像在执行时调整大小。 */
  pastedContents?: Record<number, PastedContent>
  /** 在 [Pasted text #N] 占位符展开之前的输入字符串。在粘贴内容占位符展开之前保留输入。 */
  preExpansionValue?: string
  /** 如果为 true，则即使输入以 `/` 开头，也视为纯文本。用于不应触发本地斜杠命令的注入消息。 */
  skipSlashCommands?: boolean
  /**
   * 如果为 true，则生成的 UserMessage 将获得 `isMeta: true` — 在转录 UI 中隐藏但模型可见。用于系统生成的提示（主动滴答、队友消息、资源更新），这些提示通过队列路由而不是直接调用 `onQuery`。
   */
  isMeta?: boolean
  /** 此命令的来源。标记到生成的 UserMessage 上，以便转录从结构上记录来源（而不仅仅是内容中的 XML 标签）。undefined = 人类（键盘）。 */
  origin?: MessageOrigin
  /**
   * 工作量标签，通过 billing-header 归属块中的 cc_workload= 线程化。队列是 cron 调度器触发和回合实际运行之间的异步边界 — 用户提示可能插入其间 — 因此标签存在于 QueuedCommand 本身，并且仅在此命令出队时才提升为引导状态。
   */
  workload?: string
  /**
   * 应接收此通知的代理。undefined = 主线程。子代理在进程内运行并共享模块级命令队列；query.ts 中的排空门按此字段过滤，以便子代理的后台任务通知不会泄露到协调器的上下文中（PR #18453 统一了队列，但丢失了双队列偶然具有的隔离性）。
   */
  agentId?: AgentId
}

/**
 * 用于包含非空数据的图像 PastedContent 的类型守卫。空内容图像（例如从 0 字节文件拖放）产生空 base64 字符串，API 会拒绝并提示 `image cannot be empty`。在将 PastedContent 转换为 ImageBlockParam 的每个位置使用此守卫，以便过滤器和 ID 列表保持同步。
 */
/** 判断是否满足 is Valid Image Paste 对应的数据或状态。 */
export function isValidImagePaste(c: PastedContent): boolean {
  return c.type === 'image' && c.content.length > 0
}

/** 从 QueuedCommand 的 pastedContents 中提取图像粘贴 ID。 */
/** 获取 get Image Paste Ids 对应的数据或状态。 */
export function getImagePasteIds(
  pastedContents: Record<number, PastedContent> | undefined,
): number[] | undefined {
  if (!pastedContents) {
    return undefined
  }
  /** 执行 ids 对应的业务处理。 */
  const ids = Object.values(pastedContents)
    .filter(isValidImagePaste)
    .map(c => c.id)
  return ids.length > 0 ? ids : undefined
}

export type OrphanedPermission = {
  permissionResult: PermissionResult
  assistantMessage: AssistantMessage
}
