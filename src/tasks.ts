import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'

/**
 * 获取所有任务。
 * 镜像来自tools.ts的模式
 * 注意：返回内联数组以避免与顶层常量的循环依赖问题。
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,    DreamTask,
  ]
  return tasks
}

/** 按其类型获取任务。 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
