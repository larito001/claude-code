/**
 * 跟踪进程内设置文件写入的时间戳，以便 changeDetector.ts 中的 chokidar 监视器可以忽略自身的回显。
 *
 * 从 changeDetector.ts 中提取出来，以打破 settings.ts → changeDetector.ts → hooks.ts → … → settings.ts 的循环。settings.ts 需要在写入生效前标记“我即将写入”；changeDetector 需要在 chokidar 触发时读取该标记。该映射是唯一的共享状态。
 *
 * 调用者传入解析后的路径。路径→源的解析（getSettingsFilePathForSource）位于 settings.ts 中，因此 settings.ts 会在调用此处之前执行该解析。无导入。
 */

const timestamps = new Map<string, number>()

/** 执行 mark Internal Write 对应的业务处理。 */
export function markInternalWrite(path: string): void {
  timestamps.set(path, Date.now())
}

/** 如果 `path` 在 `windowMs` 内被标记，则返回 true。匹配时会消耗该标记——监视器每次写入触发一次，因此匹配的标记不应抑制对同一文件的后续（真实的、来自外部的）更改。 */
export function consumeInternalWrite(path: string, windowMs: number): boolean {
  const ts = timestamps.get(path)
  if (ts !== undefined && Date.now() - ts < windowMs) {
    timestamps.delete(path)
    return true
  }
  return false
}

/** 删除或清理 clear Internal Writes 对应的数据或状态。 */
export function clearInternalWrites(): void {
  timestamps.clear()
}
