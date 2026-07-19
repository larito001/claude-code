import { jsonStringify } from '../utils/slowOperations.js'

// JSON.stringify 会原样输出 U+2028/U+2029（符合 ECMA-404）。当输出为单行 NDJSON 时，任何使用 JavaScript 行终止符语义（ECMA-262 §11.3 — \n \r U+2028 U+2029）分割流的接收方都会在字符串中间截断 JSON。ProcessTransport 现在会静默跳过非 JSON 行而非崩溃（gh-28405），但截断的片段仍然丢失——消息被静默丢弃。
//
// \uXXXX 形式是等价的 JSON（解析后得到相同字符串），但绝不会被任何接收方误认为是行终止符。这正是 ES2019 的 "Subsume JSON" 提案和 Node 的 util.inspect 的做法。
//
// 单一交替正则：回调每次匹配只分发一次，比两次全字符串扫描成本更低。
const JS_LINE_TERMINATORS = /\u2028|\u2029/g

/** 执行 escape Js Line Terminators 对应的业务处理。 */
function escapeJsLineTerminators(json: string): string {
  return json.replace(JS_LINE_TERMINATORS, c =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
}

/** 针对每行一条消息的传输优化的 JSON.stringify。转义 U+2028 行分隔符和 U+2029 段落分隔符，使序列化输出不会被行分割接收方破坏。输出仍是有效 JSON，解析后得到相同值。 */
export function ndjsonSafeStringify(value: unknown): string {
  return escapeJsLineTerminators(jsonStringify(value))
}
