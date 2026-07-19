/**
 * 面向框架使用者的公共 SDK 门面。
 *
 * 运行时函数和公共类型来自持续维护的 Claude Agent SDK 依赖；钩子事件与
 * 退出原因常量固定在当前源码的协议版本，确保内部注册逻辑与 Schema 一致。
 */
export * from '@anthropic-ai/claude-agent-sdk'
export { HOOK_EVENTS, EXIT_REASONS } from './sdk/coreTypes.js'
