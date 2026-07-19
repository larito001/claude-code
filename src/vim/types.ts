/**
 * Vim模式状态机类型
 *
 * 此文件定义了用于vim输入处理的完整状态机。类型本身就是文档——阅读它们就能知道系统如何工作。
 *
 * 状态图：
 * ```
 *                              VimState
 *   ┌──────────────────────────────┬──────────────────────────────────────┐
 *   │  INSERT                      │  NORMAL                              │
 *   │  (tracks insertedText)       │  (CommandState machine)              │
 *   │                              │                                      │
 *   │                              │  idle ──┬─[d/c/y]──► operator        │
 *   │                              │         ├─[1-9]────► count           │
 *   │                              │         ├─[fFtT]───► find            │
 *   │                              │         ├─[g]──────► g               │
 *   │                              │         ├─[r]──────► replace         │
 *   │                              │         └─[><]─────► indent          │
 *   │                              │                                      │
 *   │                              │  operator ─┬─[motion]──► execute     │
 *   │                              │            ├─[0-9]────► operatorCount│
 *   │                              │            ├─[ia]─────► operatorTextObj
 *   │                              │            └─[fFtT]───► operatorFind │
 *   └──────────────────────────────┴──────────────────────────────────────┘
 */

// ============================================================================
// 核心类型
// ============================================================================

export type Operator = 'delete' | 'change' | 'yank'

export type FindType = 'f' | 'F' | 't' | 'T'

export type TextObjScope = 'inner' | 'around'

// ============================================================================
// 状态机类型
// ============================================================================

/**
 * 完整的 vim 状态。模式决定追踪哪些数据。
 *
 * INSERT 模式：追踪正在键入的文本（用于点重复）
 * NORMAL 模式：追踪正在解析的命令（状态机）
 */
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

/**
 * NORMAL 模式的命令状态机。
 *
 * 每个状态确切地知道它在等待什么输入。
 * TypeScript 确保在 switch 语句中进行穷举处理。
 */
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | {
      type: 'operatorTextObj'
      op: Operator
      count: number
      scope: TextObjScope
    }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }

/**
 * 跨命令持久存在的状态。
 * 这是 vim 的“记忆”——在重复和粘贴时被召回的内容。
 */
export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

/**
 * 为点重复记录的变化。
 * 捕获重放命令所需的一切。
 */
export type RecordedChange =
  | { type: 'insert'; text: string }
  | {
      type: 'operator'
      op: Operator
      motion: string
      count: number
    }
  | {
      type: 'operatorTextObj'
      op: Operator
      objType: string
      scope: TextObjScope
      count: number
    }
  | {
      type: 'operatorFind'
      op: Operator
      find: FindType
      char: string
      count: number
    }
  | { type: 'replace'; char: string; count: number }
  | { type: 'x'; count: number }
  | { type: 'toggleCase'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'openLine'; direction: 'above' | 'below' }
  | { type: 'join'; count: number }

// ============================================================================
// 键分组——命名常量，没有魔数串
// ============================================================================

export const OPERATORS = {
  d: 'delete',
  c: 'change',
  y: 'yank',
} as const satisfies Record<string, Operator>

/** 判断是否满足 is Operator Key 对应的数据或状态。 */
export function isOperatorKey(key: string): key is keyof typeof OPERATORS {
  return key in OPERATORS
}

export const SIMPLE_MOTIONS = new Set([
  'h',
  'l',
  'j',
  'k', // 基础移动
  'w',
  'b',
  'e',
  'W',
  'B',
  'E', // 单词动作
  '0',
  '^',
  '$', // 行位置
])

export const FIND_KEYS = new Set(['f', 'F', 't', 'T'])

export const TEXT_OBJ_SCOPES = {
  i: 'inner',
  a: 'around',
} as const satisfies Record<string, TextObjScope>

/** 判断是否满足 is Text Obj Scope Key 对应的数据或状态。 */
export function isTextObjScopeKey(
  key: string,
): key is keyof typeof TEXT_OBJ_SCOPES {
  return key in TEXT_OBJ_SCOPES
}

export const TEXT_OBJ_TYPES = new Set([
  'w',
  'W', // Vim 的 Word/WORD 单词对象
  '"',
  "'",
  '`', // 引号
  '(',
  ')',
  'b', // 圆括号
  '[',
  ']', // 方括号
  '{',
  '}',
  'B', // 花括号
  '<',
  '>', // 尖括号
])

export const MAX_VIM_COUNT = 10000

// ============================================================================
// 状态工厂
// ============================================================================

/** 创建 create Initial Vim State 对应的数据或状态。 */
export function createInitialVimState(): VimState {
  return { mode: 'INSERT', insertedText: '' }
}

/** 创建 create Initial Persistent State 对应的数据或状态。 */
export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  }
}
