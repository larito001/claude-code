/**
 * 用于在生产环境中追踪错误源头的错误ID。
 * 这些ID是经过混淆的标识符，帮助我们追溯
 * 哪个logError()调用产生了错误。
 *
 * 这些错误以独立的const导出表示，因此打包后的代码
 * 只保留它所引用的数值标识符。
 *
 * 添加新的错误类型：
 * 1. 基于下一个ID添加一个const。
 * 2. 递增下一个ID。
 * 下一个ID：346
 */

export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344
