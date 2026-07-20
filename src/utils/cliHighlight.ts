// MCP 和 HTTP 传输层使用 DOM 兼容的请求类型，而基础 tsconfig 仅包含 ESNext。
/// <reference lib="dom" />

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// 多个渲染入口共享同一个延迟加载结果，避免重复导入高亮模块。
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    return {
      highlight: cliHighlight.highlight,
      supportsLanguage: cliHighlight.supportsLanguage,
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}
