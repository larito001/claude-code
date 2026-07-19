/**
 * SDK 控制协议的静态类型。
 *
 * 所有类型都从同目录的运行时 Zod Schema 推导，避免协议校验规则与
 * TypeScript 声明分别维护后逐渐偏离。
 */
import type { z } from 'zod/v4'
import type {
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  StdinMessageSchema,
  StdoutMessageSchema,
} from './controlSchemas.js'

export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>
export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>
export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>
export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>
export type SDKControlRequest = z.infer<
  ReturnType<typeof SDKControlRequestSchema>
>
export type SDKControlResponse = z.infer<
  ReturnType<typeof SDKControlResponseSchema>
>
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>
export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>
