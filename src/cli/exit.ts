/**
 * CLI 退出辅助工具，用于子命令处理器。
 *
 * 将那些在 `claude mcp *` / `claude plugin *` 处理器中复制粘贴了约 60 次的 4-5 行“打印 + lint 抑制 + 退出”代码块整合起来。
 * `: never` 返回类型让 TypeScript 在调用点能够收窄控制流，而无需在末尾添加 `return`。
 */
/* eslint-disable custom-rules/no-process-exit -- centralized CLI exit point */

// `return undefined as never`（不是退出后抛出）——测试会监视 process.exit 并让其返回。调用点写 `return cliError(...)`，在模拟环境下后续代码会对已经被收窄掉的值进行解引用。cliError 使用 console.error（测试监视 console.error）；cliOk 使用 process.stdout.write（测试监视 process.stdout.write——Bun 的 console.log 不会通过被监视的 process.stdout.write 路由）。

/** 将错误信息写入 stderr（如果提供），并以状态码 1 退出。 */
export function cliError(msg?: string): never {
  // biome-ignore lint/suspicious/noConsole: centralized CLI error output
  if (msg) console.error(msg)
  process.exit(1)
  return undefined as never
}

/** 将消息写入 stdout（如果提供），并以状态码 0 退出。 */
export function cliOk(msg?: string): never {
  if (msg) process.stdout.write(msg + '\n')
  process.exit(0)
  return undefined as never
}
