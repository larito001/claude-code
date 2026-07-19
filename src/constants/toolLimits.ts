/** 与工具结果大小限制相关的常量 */

/**
 * 工具结果在持久化到磁盘之前的默认最大字符数。当超过此值时，结果将保存到文件，模型将收到包含文件路径的预览，而不是完整内容。
 *
 * 各个工具可能会声明更低的 maxResultSizeChars，但此常量作为系统级上限，无论工具如何声明都适用。
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/**
 * 工具结果的最大标记数（token）。
 * 基于对工具结果大小的分析，我们将其设置为合理的上限，以防止过大的工具结果消耗过多上下文。
 *
 * 这大约为 400KB 的文本（假设每个标记约 4 字节）。
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000

/** 从字节大小计算标记数时使用的每标记字节数估计值。这是一个保守的估计——实际标记数可能有所不同。 */
export const BYTES_PER_TOKEN = 4

/** 工具结果的最大字节大小（源自标记限制）。 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * 单个用户消息（一轮并行工具结果的批次）中 tool_result 块的默认最大总字符数。当消息中的块总和超过此值时，该消息中最大的块会被持久化到磁盘，并用预览替换，直到总大小在预算内。消息独立评估——一个轮次中的 150K 结果和下一个轮次中的 150K 结果都不会被触及。
 *
 * 这可以防止 N 个并行工具各自达到每个工具的最大值，从而在一轮的用户消息中共同产生例如 10 × 40K = 400K 的数据。
 *
 * 可通过本地特性配置标志 tengu_hawthorn_window 在运行时覆盖——参见 toolResultStorage.ts 中的 getPerMessageBudgetLimit()。
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/** 紧凑视图中工具摘要字符串的最大字符长度。由 getToolUseSummary() 实现用于截断长输入，以便在分组代理渲染中显示。 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
