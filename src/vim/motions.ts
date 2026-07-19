/**
 * Vim 运动函数
 *
 * 用于将 vim 运动解析为光标位置的纯函数。
 */

import type { Cursor } from '../utils/Cursor.js'

/**
 * 将运动解析为目标光标位置。
 * 不修改任何内容 - 纯计算。
 */
export function resolveMotion(
  key: string,
  cursor: Cursor,
  count: number,
): Cursor {
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result)
    if (next.equals(result)) break
    result = next
  }
  return result
}

/** 应用单个运动步骤。 */
function applySingleMotion(key: string, cursor: Cursor): Cursor {
  switch (key) {
    case 'h':
      return cursor.left()
    case 'l':
      return cursor.right()
    case 'j':
      return cursor.downLogicalLine()
    case 'k':
      return cursor.upLogicalLine()
    case 'gj':
      return cursor.down()
    case 'gk':
      return cursor.up()
    case 'w':
      return cursor.nextVimWord()
    case 'b':
      return cursor.prevVimWord()
    case 'e':
      return cursor.endOfVimWord()
    case 'W':
      return cursor.nextWORD()
    case 'B':
      return cursor.prevWORD()
    case 'E':
      return cursor.endOfWORD()
    case '0':
      return cursor.startOfLogicalLine()
    case '^':
      return cursor.firstNonBlankInLogicalLine()
    case '$':
      return cursor.endOfLogicalLine()
    case 'G':
      return cursor.startOfLastLine()
    default:
      return cursor
  }
}

/** 检查运动是否为包含性（包含目标位置的字符）。 */
export function isInclusiveMotion(key: string): boolean {
  return 'eE$'.includes(key)
}

/**
 * 检查运动是否为行块（与操作符一起使用时作用于整行）。
 * 注意：根据 `:help gj`，gj/gk 是字符独享的，而非行块。
 */
export function isLinewiseMotion(key: string): boolean {
  return 'jkG'.includes(key) || key === 'gg'
}
