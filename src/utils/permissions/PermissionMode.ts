import { feature } from 'src/utils/features.js'
import z from 'zod/v4'
import { PAUSE_ICON } from '../../constants/figures.js'
// 将类型提取到 src/types/permissions.ts 以打破导入循环
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../types/permissions.js'
import { lazySchema } from '../lazySchema.js'

// 为了向后兼容而重新导出
export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
}

/** 执行 permission Mode Schema 对应的业务处理。 */
export const permissionModeSchema = lazySchema(() => z.enum(PERMISSION_MODES))
/** 执行 external Permission Mode Schema 对应的业务处理。 */
export const externalPermissionModeSchema = lazySchema(() =>
  z.enum(EXTERNAL_PERMISSION_MODES),
)

type ModeColorKey =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

const PERMISSION_MODE_CONFIG: Partial<
  Record<PermissionMode, PermissionModeConfig>
> = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  ...(feature('TRANSCRIPT_CLASSIFIER')
    ? {
        auto: {
          title: 'Auto mode',
          shortTitle: 'Auto',
          symbol: '⏵⏵',
          color: 'warning' as ModeColorKey,
          external: 'auto' as ExternalPermissionMode,
        },
      }
    : {}),
}

/** 类型守卫，用于检查 PermissionMode 是否是 ExternalPermissionMode。 */
export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  return mode !== 'bubble'
}

/** 获取 get Mode Config 对应的数据或状态。 */
function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

/** 转换 to External Permission Mode 对应的数据或状态。 */
export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return getModeConfig(mode).external
}

/** 执行 permission Mode From String 对应的业务处理。 */
export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default'
}

/** 执行 permission Mode Title 对应的业务处理。 */
export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title
}

/** 判断是否满足 is Default Mode 对应的数据或状态。 */
export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

/** 执行 permission Mode Short Title 对应的业务处理。 */
export function permissionModeShortTitle(mode: PermissionMode): string {
  return getModeConfig(mode).shortTitle
}

/** 执行 permission Mode Symbol 对应的业务处理。 */
export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol
}

/** 获取 get Mode Color 对应的数据或状态。 */
export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}
