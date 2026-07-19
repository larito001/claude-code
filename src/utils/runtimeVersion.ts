/** 源码模式下使用的上游核心版本；生产构建会由 `MACRO.VERSION` 覆盖。 */
const SOURCE_CORE_VERSION = '2.1.87'

/**
 * 获取当前核心版本。该方法在 CLI 主入口尚未注入构建宏时也可安全调用，
 * 以支持测试脚本、SDK 和二次开发代码直接导入底层模块。
 */
export function getRuntimeVersion(): string {
  return typeof MACRO === 'undefined' ? SOURCE_CORE_VERSION : MACRO.VERSION
}
