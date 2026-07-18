# Claude Code 源码：可构建的研究分支

[![构建状态](https://img.shields.io/badge/build-passing-brightgreen)]()
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white)]()
[![代码行数](https://img.shields.io/badge/lines-512K+-blue)]()
[![许可证](https://img.shields.io/badge/license-research%20only-orange)]()
[![Stars](https://img.shields.io/github/stars/beita6969/claude-code?style=social)](https://github.com/beita6969/claude-code/stargazers)
[![Forks](https://img.shields.io/github/forks/beita6969/claude-code?style=social)](https://github.com/beita6969/claude-code/network/members)

> Claude Code 源码的一个**可构建、可修改、可运行**版本。

本项目基于 2026-03-31 通过 npm source map 泄露而公开的 Claude Code 源码快照。原始快照仅含原始 TypeScript 源码，没有构建配置，因此无法编译或运行。本分支重建了完整构建系统，并修复缺失组件以使其可用。

**[快速开始](#快速开始)** | **[架构](#架构概览)** | **[功能开关](#功能开关)** | **[扩展指南](#扩展点无需修改源码)**

---

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.3.x
- `.env` 中配置有效的 `DEEPSEEK_API_KEY`（开发入口会映射给 Anthropic 兼容 SDK）

### 安装与运行

```bash
git clone https://github.com/beita6969/claude-code.git
cd claude-code

# 安装依赖（postinstall 会自动创建 bun:bundle polyfill）
bun install

# 直接运行（自动读取 .env）
bun run dev -- -p "your prompt here" --output-format text
```

### 构建（可选）

```bash
# 编译为单一 bundle（约 20MB）
bun build src/entrypoints/cli.tsx --outdir=dist --target=bun
```

### 运行模式

```bash
# 无界面输出模式（无需 TTY）
bun src/entrypoints/cli.tsx -p "your prompt here" --output-format text

# JSON 输出
bun src/entrypoints/cli.tsx -p "your prompt here" --output-format json

# 交互式 REPL 模式（需要 TTY）
bun src/entrypoints/cli.tsx
```

> **注意**：此裁剪版只使用 API Key，不包含 Claude/Anthropic 网页登录、订阅认证、Claude in Chrome 或 Computer Use 流程。

---

## 与原始快照相比的变更

原始快照**没有 `package.json`、`tsconfig.json`、锁文件或构建脚本**，并且 source map 缺少 100 多个内部模块及功能门控模块。

### 构建系统（已重建）

| 文件 | 用途 |
|------|------|
| `package.json` | 根据约 1,900 个源文件逆向整理出的 60+ npm 依赖 |
| `tsconfig.json` | TypeScript 配置（ESNext、JSX、Bun bundler 模块解析） |
| `bunfig.toml` | Bun 运行时配置 |
| `scripts/postinstall.ts` | 跨平台地在 `bun install` 后创建 `bun:bundle` 运行时 polyfill |
| `.gitignore` | 排除 `node_modules/`、`dist/` 和锁文件 |

### 依赖适配与裁剪

- Sharp、Turndown、Bedrock/Foundry/Vertex、AWS/Azure 与 OpenTelemetry 已接入公开正式包。
- `color-diff-napi` 已替换为项目内 TypeScript 实现。
- Claude in Chrome、Computer Use 及其 `@ant/*` 私有依赖已沿入口、UI、配置和 MCP 调用链删除。
- `audio-capture-napi` 无调用方，已删除；`modifiers-napi` 改为跨平台可降级的可选能力。

### 源码修复

| 文件 | 变更 |
|------|------|
| `src/main.tsx` | 运行时注入 `MACRO` 常量（生产环境中为编译期定义） |
| `src/main.tsx` | 修复 Commander.js 对 `-d2e` 短参数的不兼容问题 |
| `src/bootstrap/state.ts` | 增加缺失的 `isReplBridgeActive()` 导出 |
| `src/types/connectorText.ts` | 增加 `isConnectorTextBlock` 函数 stub |
| `src/tools/WorkflowTool/constants.ts` | 增加 `WORKFLOW_TOOL_NAME` 导出 |

---

## 架构概览

```
src/
├── main.tsx              # CLI 入口（Commander.js + React/Ink）
├── QueryEngine.ts        # 核心 LLM API 引擎
├── query.ts              # Agent 循环（异步生成器）
├── Tool.ts               # 工具类型定义
├── tools.ts              # 工具注册表
├── commands.ts           # 命令注册表
├── context.ts            # 系统提示词上下文
│
├── tools/                # 40+ 工具实现
│   ├── AgentTool/        # 子代理创建与协调
│   ├── BashTool/         # Shell 命令执行
│   ├── FileReadTool/     # 文件读取
│   ├── FileEditTool/     # 文件编辑
│   ├── GrepTool/         # 基于 ripgrep 的搜索
│   ├── MCPTool/          # MCP 服务器工具调用
│   ├── SkillTool/        # 技能执行
│   └── ...
│
├── services/             # 外部集成
│   ├── api/              # Anthropic API 客户端
│   ├── mcp/              # MCP 服务器管理
│   └── ...
│
├── memdir/               # 持久化记忆系统
├── skills/               # 技能系统（内置与用户自定义）
├── components/           # React/Ink 终端 UI
├── hooks/                # React Hooks
├── coordinator/          # 多代理编排
└── stubs/                # 少量运行时兼容模块
```

### 关键系统

| 系统 | 文件 | 说明 |
|------|------|------|
| **Agent 循环** | `query.ts`、`QueryEngine.ts` | `while(true)` 异步生成器：查询 → 工具调用 → 返回结果 → 继续循环 |
| **记忆** | `memdir/` | 四类基于文件的记忆（用户、反馈、项目、参考），以 `MEMORY.md` 为索引 |
| **MCP** | `services/mcp/` | Model Context Protocol 服务器管理（stdio/http/sse/ws） |
| **技能** | `skills/`、`tools/SkillTool/` | 可复用的工作流模板（`SKILL.md` 格式） |
| **代理** | `tools/AgentTool/` | 通过 `.claude/agents/*.md` 定义自定义代理类型 |
| **系统提示词** | `constants/prompts.ts` | 分层提示词：静态 → 动态 → 记忆 → 代理 |

### 扩展点（无需修改源码）

| 机制 | 位置 | 格式 |
|------|------|------|
| 自定义技能 | `.claude/skills/name/SKILL.md` | YAML frontmatter + Markdown |
| 自定义代理 | `.claude/agents/name.md` | YAML frontmatter + Markdown |
| MCP 服务器 | `.mcp.json` | JSON 配置 |
| Hooks | `~/.claude/settings.json` | JSON 事件—操作映射 |

---

## 功能开关

`bun:bundle` 的 `feature()` 函数控制功能门控。在本构建中，所有功能默认**关闭**。如需启用功能，请编辑由 `bun install` 自动生成的 `node_modules/bundle/index.js`：

```javascript
const ENABLED_FEATURES = new Set([
  // 取消注释即可启用：
  // 'KAIROS',              // 助手模式
  // 'PROACTIVE',           // 主动模式
  // 'BRIDGE_MODE',         // IDE 桥接
  // 'VOICE_MODE',          // 语音输入
  // 'COORDINATOR_MODE',    // 多代理协调器
  // 'EXTRACT_MEMORIES',    // 后台记忆提取
  // 'TEAMMEM',             // 团队记忆
])
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Bun |
| 语言 | TypeScript（严格模式） |
| 终端 UI | React + Ink |
| CLI | Commander.js |
| 校验 | Zod v4 |
| 搜索 | ripgrep |
| 协议 | MCP SDK、LSP |
| API | Anthropic SDK |
| 遥测 | OpenTelemetry |

---

## 规模

- **约 1,900 个源文件**
- **512,000+ 行 TypeScript**
- **40+ 个工具**、**100+ 条命令**、**140+ 个 UI 组件**
- **20MB** 编译产物

---

## 免责声明

- 本仓库仅用于**教育和研究用途**。
- 原始 Claude Code 源码属于 **Anthropic**。
- 本仓库**不隶属于 Anthropic，未获 Anthropic 认可，也不由 Anthropic 维护**。
- 原始源码公开时间：2026-03-31，来源为 npm source map 泄露。

---

如果这对你的研究有帮助，欢迎点个 Star。
