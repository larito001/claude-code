# Claude Code 核心开发框架

这是一个面向二次开发的 Claude Code 核心基底。项目保留原有 Agent 循环、工具系统、终端交互和扩展协议，移除 Claude/Anthropic 网页登录、订阅认证及与账号产品绑定的外围能力。

默认开发配置使用 `.env` 中的 API Key，不会启动登录或 `/logout` 流程。

## 保留的核心

- Query/Agent 执行循环与流式响应
- Bash、PowerShell、文件读写、搜索、计划和子 Agent 工具
- Command、Tool、Agent、Skill、Plugin、Hook 扩展接口
- MCP stdio、HTTP、SSE 与 OAuth 服务器接入
- 会话持久化、恢复、回退与导出
- 自动压缩、上下文提醒和文件记忆
- 权限规则、沙箱与工作目录隔离
- React/Ink 交互式终端 UI
- API Key 兼容端点与公开 Agent SDK 门面
- Windows、macOS、Linux 路径和 Shell 适配

已删除的主要内容包括网页登录/订阅认证、Bedrock/Vertex/Foundry 多云 Provider、远程插件市场及其安装更新链路、Claude.ai 远程会话与远程配置、Desktop/Chrome 产品引流、反馈调查、内部 Daemon/Runner、缺失实现的 Workflow/Monitor/WebBrowser 实验入口。通用 MCP OAuth 和显式加载的本地插件属于核心扩展能力，因此仍保留。

## 环境要求

- Bun 1.3 或更高版本
- 一个 Anthropic 兼容 API 的 Key
- 建议安装 Git 与 ripgrep

## 快速启动

安装依赖：

```bash
bun install
```

复制配置模板，并填写自己的 Key：

```powershell
Copy-Item .env.example .env
```

macOS/Linux：

```bash
cp .env.example .env
```

交互式启动：

```bash
bun run dev
```

单次调用：

```bash
bun run dev -- -p "只回复 OK" --output-format text
```

`bun run dev` 会明确加载仓库根目录的 `.env`。当设置 `DEEPSEEK_API_KEY` 时，入口会把它映射到 Anthropic 兼容 SDK 使用的 `ANTHROPIC_API_KEY`；也可以直接配置标准的 `ANTHROPIC_API_KEY`。

## `.env` 配置

DeepSeek 示例：

```dotenv
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=replace-with-your-api-key
ANTHROPIC_MODEL=deepseek-v4-flash
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
```

其他兼容 Anthropic API 协议的服务可替换 `ANTHROPIC_BASE_URL`、模型名和 API Key。真实 `.env` 已被 Git 忽略，不要把密钥提交到仓库。

## 全新存储命名空间

- 用户数据根目录：`~/.claude-code-core-framework/`
- 全局配置：`~/.claude-code-core-framework/config.json`，固定从 `schemaVersion: 1` 开始
- 用户设置：`~/.claude-code-core-framework/settings.json`
- 项目数据：项目下的 `.claude-code-core-framework/`
- 自定义根目录：设置 `FRAMEWORK_CONFIG_DIR`

框架不会扫描或迁移旧 `.claude/`、`~/.claude.json`、旧相邻 `.backup` 文件及旧系统钥匙串。配置备份统一写入新命名空间的 `backups/`。自定义提示统一使用 `skills/<name>/SKILL.md`，不再读取旧 `commands/` 目录。

## IDE 中运行

在 JetBrains IDE 或 VS Code 中创建 Bun 运行配置：

- 入口：`src/entrypoints/cli.tsx`
- 工作目录：仓库根目录
- 环境文件：仓库根目录的 `.env`
- 终端：启用交互式/TTY 终端

无 TTY 的普通 Run Console 只适合 `-p` 单次调用；完整输入框和快捷键需要交互式终端。

## 构建与检查

```bash
# 类型检查、CLI + SDK 构建及完整离线冒烟门禁
bun run smoke:offline

# 只构建
bun run build

# 运行构建产物
bun dist/cli.js
```

`bun run typecheck` 检查公共 SDK、feature 配置和新增的框架维护模块。`bun run typecheck:legacy` 用于审计原始 React Compiler 生成源码；这批源码包含上游生成代码的静态类型噪声，运行正确性以正式构建和冒烟测试为准。

## 配置界面

```bash
bun run config
```

界面仅监听 `127.0.0.1:3456`，可管理：

- 用户、项目和本地 settings
- 模型、权限与 Hooks
- Agent 和 Skill 文件
- `.mcp.json`
- CLAUDE.md 与记忆文件
- 已支持的本地 framework feature

Feature 配置只会更新 `.env` 中的 `CLAUDE_CODE_FEATURES` 和 `CLAUDE_CODE_DISABLE_FEATURES`，不会读取或返回 API Key。

## 扩展点

| 能力 | 默认位置 | 说明 |
| --- | --- | --- |
| Project Skill | `.claude-code-core-framework/skills/<name>/SKILL.md` | YAML frontmatter + Markdown |
| Project Agent | `.claude-code-core-framework/agents/<name>.md` | Prompt、工具、模型和权限 |
| Project Hook | `.claude-code-core-framework/settings.json` | 生命周期事件与命令/Prompt Hook |
| MCP Server | `.mcp.json` | stdio/http/sse/ws 配置 |
| Local Plugin | `--plugin-dir <path>` | Command、Skill、Agent、Hook、MCP、LSP 和输出样式组合扩展 |
| SDK | `src/entrypoints/agentSdkTypes.ts` | 公开 Agent SDK API 和本地协议常量 |

核心 feature 默认开启；已适配但默认关闭的本地能力可通过环境变量启用：

```dotenv
CLAUDE_CODE_FEATURES=PROACTIVE,COORDINATOR_MODE
CLAUDE_CODE_DISABLE_FEATURES=QUICK_SEARCH
```

未知或未审计的历史 feature 不会被启用，避免缺失的内部产品模块进入商业运行链路。

## 核心目录

```text
src/
├── entrypoints/           CLI 与 SDK 入口
├── QueryEngine.ts         查询生命周期和状态编排
├── query.ts               Agent/Tool 循环
├── Tool.ts                工具契约
├── tools.ts               工具注册表
├── commands.ts            命令与 Skill 注册表
├── services/api/          兼容 API、重试与流式事件
├── services/mcp/          MCP 配置和连接管理
├── tools/AgentTool/       内置/自定义 Agent 与子任务
├── skills/                Skill 加载和执行
├── utils/hooks/           Hook 注册与生命周期
├── utils/sessionStorage.ts 会话持久化与恢复
├── services/compact/      上下文压缩
├── memdir/                文件记忆
└── components/            React/Ink TUI
```

## 商业使用提示

本仓库的工程目标是成为可扩展基底，但商业发布前仍应完成你自己的产品命名、品牌替换、安全评审、依赖许可证清单和上游代码授权确认。不要使用 Anthropic 或 Claude 商标暗示官方关系。
