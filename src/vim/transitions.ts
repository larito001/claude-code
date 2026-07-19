/**
 * Vim 状态转换表
 *
 * 这是状态转换的可扫描真实来源。
 * 要了解任何状态下的行为，请查看该状态的转换函数。
 */

import { resolveMotion } from './motions.js'
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorG,
  executeOperatorGg,
  executeOperatorMotion,
  executeOperatorTextObj,
  executePaste,
  executeReplace,
  executeToggleCase,
  executeX,
  type OperatorContext,
} from './operators.js'
import {
  type CommandState,
  FIND_KEYS,
  type FindType,
  isOperatorKey,
  isTextObjScopeKey,
  MAX_VIM_COUNT,
  OPERATORS,
  type Operator,
  SIMPLE_MOTIONS,
  TEXT_OBJ_SCOPES,
  TEXT_OBJ_TYPES,
  type TextObjScope,
} from './types.js'

/** 传递给转换函数的上下文。 */
export type TransitionContext = OperatorContext & {
  /** 处理 on Undo 对应的数据或状态。 */
  onUndo?: () => void
  /** 处理 on Dot Repeat 对应的数据或状态。 */
  onDotRepeat?: () => void
}

/** 转换的结果。 */
export type TransitionResult = {
  next?: CommandState
  /** 执行 execute 对应的数据或状态。 */
  execute?: () => void
}

/** 主转换函数。根据当前状态类型进行分发。 */
export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  switch (state.type) {
    case 'idle':
      return fromIdle(input, ctx)
    case 'count':
      return fromCount(state, input, ctx)
    case 'operator':
      return fromOperator(state, input, ctx)
    case 'operatorCount':
      return fromOperatorCount(state, input, ctx)
    case 'operatorFind':
      return fromOperatorFind(state, input, ctx)
    case 'operatorTextObj':
      return fromOperatorTextObj(state, input, ctx)
    case 'find':
      return fromFind(state, input, ctx)
    case 'g':
      return fromG(state, input, ctx)
    case 'operatorG':
      return fromOperatorG(state, input, ctx)
    case 'replace':
      return fromReplace(state, input, ctx)
    case 'indent':
      return fromIndent(state, input, ctx)
  }
}

// ============================================================================
// 共享输入处理
// ============================================================================

/**
 * 处理在空闲和计数状态下都有效的输入。
 * 如果输入未被识别，则返回 null。
 */
function handleNormalInput(
  input: string,
  count: number,
  ctx: TransitionContext,
): TransitionResult | null {
  if (isOperatorKey(input)) {
    return { next: { type: 'operator', op: OPERATORS[input], count } }
  }

  if (SIMPLE_MOTIONS.has(input)) {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => {
        const target = resolveMotion(input, ctx.cursor, count)
        ctx.setOffset(target.offset)
      },
    }
  }

  if (FIND_KEYS.has(input)) {
    return { next: { type: 'find', find: input as FindType, count } }
  }

  if (input === 'g') return { next: { type: 'g', count } }
  if (input === 'r') return { next: { type: 'replace', count } }
  if (input === '>' || input === '<') {
    return { next: { type: 'indent', dir: input, count } }
  }
  if (input === '~') {
    return {
      /** 执行大小写切换。 */
      execute: () => executeToggleCase(count, ctx),
    }
  }
  if (input === 'x') {
    return {
      /** 删除光标处字符。 */
      execute: () => executeX(count, ctx),
    }
  }
  if (input === 'J') {
    return {
      /** 合并当前行及后续行。 */
      execute: () => executeJoin(count, ctx),
    }
  }
  if (input === 'p' || input === 'P') {
    return {
      /** 在光标前后粘贴寄存内容。 */
      execute: () => executePaste(input === 'p', count, ctx),
    }
  }
  if (input === 'D') {
    return {
      /** 删除到行尾。 */
      execute: () => executeOperatorMotion('delete', '$', 1, ctx),
    }
  }
  if (input === 'C') {
    return {
      /** 修改到行尾并进入插入模式。 */
      execute: () => executeOperatorMotion('change', '$', 1, ctx),
    }
  }
  if (input === 'Y') {
    return {
      /** 复制指定数量的整行。 */
      execute: () => executeLineOp('yank', count, ctx),
    }
  }
  if (input === 'G') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => {
        // count=1 表示没有给定计数，跳转到最后一行
        // 否则跳转到第 N 行
        if (count === 1) {
          ctx.setOffset(ctx.cursor.startOfLastLine().offset)
        } else {
          ctx.setOffset(ctx.cursor.goToLine(count).offset)
        }
      },
    }
  }
  if (input === '.') {
    return {
      /** 重复上一次修改命令。 */
      execute: () => ctx.onDotRepeat?.(),
    }
  }
  if (input === ';' || input === ',') {
    return {
      /** 按原方向或反方向重复字符查找。 */
      execute: () => executeRepeatFind(input === ',', count, ctx),
    }
  }
  if (input === 'u') {
    return {
      /** 撤销上一次修改。 */
      execute: () => ctx.onUndo?.(),
    }
  }
  if (input === 'i') {
    return {
      /** 在当前光标位置进入插入模式。 */
      execute: () => ctx.enterInsert(ctx.cursor.offset),
    }
  }
  if (input === 'I') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () =>
        ctx.enterInsert(ctx.cursor.firstNonBlankInLogicalLine().offset),
    }
  }
  if (input === 'a') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => {
        const newOffset = ctx.cursor.isAtEnd()
          ? ctx.cursor.offset
          : ctx.cursor.right().offset
        ctx.enterInsert(newOffset)
      },
    }
  }
  if (input === 'A') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => ctx.enterInsert(ctx.cursor.endOfLogicalLine().offset),
    }
  }
  if (input === 'o') {
    return {
      /** 在下方打开新行。 */
      execute: () => executeOpenLine('below', ctx),
    }
  }
  if (input === 'O') {
    return {
      /** 在上方打开新行。 */
      execute: () => executeOpenLine('above', ctx),
    }
  }

  return null
}

/**
 * 处理操作符输入（移动、查找、文本对象范围）。
 * 如果输入未被识别，则返回 null。
 */
function handleOperatorInput(
  op: Operator,
  count: number,
  input: string,
  ctx: TransitionContext,
): TransitionResult | null {
  if (isTextObjScopeKey(input)) {
    return {
      next: {
        type: 'operatorTextObj',
        op,
        count,
        scope: TEXT_OBJ_SCOPES[input],
      },
    }
  }

  if (FIND_KEYS.has(input)) {
    return {
      next: { type: 'operatorFind', op, count, find: input as FindType },
    }
  }

  if (SIMPLE_MOTIONS.has(input)) {
    return {
      /** 对指定移动范围执行操作符。 */
      execute: () => executeOperatorMotion(op, input, count, ctx),
    }
  }

  if (input === 'G') {
    return {
      /** 对文件末尾或指定行执行操作符。 */
      execute: () => executeOperatorG(op, count, ctx),
    }
  }

  if (input === 'g') {
    return { next: { type: 'operatorG', op, count } }
  }

  return null
}

// ============================================================================
// 转换函数 - 每个状态类型一个
// ============================================================================

/** 执行 from Idle 对应的业务处理。 */
function fromIdle(input: string, ctx: TransitionContext): TransitionResult {
  // 0 是行首移动，而不是计数前缀
  if (/[1-9]/.test(input)) {
    return { next: { type: 'count', digits: input } }
  }
  if (input === '0') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => ctx.setOffset(ctx.cursor.startOfLogicalLine().offset),
    }
  }

  const result = handleNormalInput(input, 1, ctx)
  if (result) return result

  return {}
}

/** 执行 from Count 对应的业务处理。 */
function fromCount(
  state: { type: 'count'; digits: string },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const count = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT)
    return { next: { type: 'count', digits: String(count) } }
  }

  const count = parseInt(state.digits, 10)
  const result = handleNormalInput(input, count, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}

/** 执行 from Operator 对应的业务处理。 */
function fromOperator(
  state: { type: 'operator'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  // dd, cc, yy = 行操作
  if (input === state.op[0]) {
    return {
      /** 执行整行删除、修改或复制。 */
      execute: () => executeLineOp(state.op, state.count, ctx),
    }
  }

  if (/[0-9]/.test(input)) {
    return {
      next: {
        type: 'operatorCount',
        op: state.op,
        count: state.count,
        digits: input,
      },
    }
  }

  const result = handleOperatorInput(state.op, state.count, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}

/** 执行 from Operator Count 对应的业务处理。 */
function fromOperatorCount(
  state: {
    type: 'operatorCount'
    op: Operator
    count: number
    digits: string
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const parsedDigits = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT)
    return { next: { ...state, digits: String(parsedDigits) } }
  }

  const motionCount = parseInt(state.digits, 10)
  const effectiveCount = state.count * motionCount
  const result = handleOperatorInput(state.op, effectiveCount, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}

/** 执行 from Operator Find 对应的业务处理。 */
function fromOperatorFind(
  state: {
    type: 'operatorFind'
    op: Operator
    count: number
    find: FindType
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return {
    /** 执行 execute 对应的数据或状态。 */
    execute: () =>
      executeOperatorFind(state.op, state.find, input, state.count, ctx),
  }
}

/** 执行 from Operator Text Obj 对应的业务处理。 */
function fromOperatorTextObj(
  state: {
    type: 'operatorTextObj'
    op: Operator
    count: number
    scope: TextObjScope
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (TEXT_OBJ_TYPES.has(input)) {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () =>
        executeOperatorTextObj(state.op, state.scope, input, state.count, ctx),
    }
  }
  return { next: { type: 'idle' } }
}

/** 执行 from Find 对应的业务处理。 */
function fromFind(
  state: { type: 'find'; find: FindType; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return {
    /** 执行 execute 对应的数据或状态。 */
    execute: () => {
      const result = ctx.cursor.findCharacter(input, state.find, state.count)
      if (result !== null) {
        ctx.setOffset(result)
        ctx.setLastFind(state.find, input)
      }
    },
  }
}

/** 执行 from G 对应的业务处理。 */
function fromG(
  state: { type: 'g'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => {
        const target = resolveMotion(`g${input}`, ctx.cursor, state.count)
        ctx.setOffset(target.offset)
      },
    }
  }
  if (input === 'g') {
    // 如果提供了计数（例如 5gg），则跳转到该行。否则跳转到第一行。
    if (state.count > 1) {
      return {
        /** 执行 execute 对应的数据或状态。 */
        execute: () => {
          const lines = ctx.text.split('\n')
          const targetLine = Math.min(state.count - 1, lines.length - 1)
          let offset = 0
          for (let i = 0; i < targetLine; i++) {
            offset += (lines[i]?.length ?? 0) + 1 // +1 表示换行
          }
          ctx.setOffset(offset)
        },
      }
    }
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () => ctx.setOffset(ctx.cursor.startOfFirstLine().offset),
    }
  }
  return { next: { type: 'idle' } }
}

/** 执行 from Operator G 对应的业务处理。 */
function fromOperatorG(
  state: { type: 'operatorG'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      /** 执行 execute 对应的数据或状态。 */
      execute: () =>
        executeOperatorMotion(state.op, `g${input}`, state.count, ctx),
    }
  }
  if (input === 'g') {
    return {
      /** 对首行或指定行执行操作符。 */
      execute: () => executeOperatorGg(state.op, state.count, ctx),
    }
  }
  // 其他输入会取消当前操作符。
  return { next: { type: 'idle' } }
}

/** 执行 from Replace 对应的业务处理。 */
function fromReplace(
  state: { type: 'replace'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  // 在字面字符状态中，Backspace/Delete 会作为空输入到达。Vim 的 r<BS> 应取消替换；若没有此保护，executeReplace("") 会误删光标下的字符。
  if (input === '') return { next: { type: 'idle' } }
  return {
    /** 用输入字符替换光标处内容。 */
    execute: () => executeReplace(input, state.count, ctx),
  }
}

/** 执行 from Indent 对应的业务处理。 */
function fromIndent(
  state: { type: 'indent'; dir: '>' | '<'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === state.dir) {
    return {
      /** 缩进或反缩进指定数量的行。 */
      execute: () => executeIndent(state.dir, state.count, ctx),
    }
  }
  return { next: { type: 'idle' } }
}

// ============================================================================
// 特殊命令辅助函数
// ============================================================================

/** 执行 execute Repeat Find 对应的数据或状态。 */
function executeRepeatFind(
  reverse: boolean,
  count: number,
  ctx: TransitionContext,
): void {
  const lastFind = ctx.getLastFind()
  if (!lastFind) return

  // 根据反向决定有效的查找类型
  let findType = lastFind.type
  if (reverse) {
    // 翻转方向
    const flipMap: Record<FindType, FindType> = {
      f: 'F',
      F: 'f',
      t: 'T',
      T: 't',
    }
    findType = flipMap[findType]
  }

  const result = ctx.cursor.findCharacter(lastFind.char, findType, count)
  if (result !== null) {
    ctx.setOffset(result)
  }
}
