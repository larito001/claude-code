import { count } from '../utils/array.js'
import type { BackgroundTaskState } from './types.js'

export function getPillLabel(tasks: BackgroundTaskState[]): string {
  const taskCount = tasks.length
  const allSameType = tasks.every(task => task.type === tasks[0]!.type)

  if (allSameType) {
    switch (tasks[0]!.type) {
      case 'local_bash': {
        const monitors = count(
          tasks,
          task => task.type === 'local_bash' && task.kind === 'monitor',
        )
        const shells = taskCount - monitors
        const parts: string[] = []
        if (shells > 0) parts.push(shells === 1 ? '1 shell' : `${shells} shells`)
        if (monitors > 0) parts.push(monitors === 1 ? '1 monitor' : `${monitors} monitors`)
        return parts.join(', ')
      }
      case 'in_process_teammate': {
        const teamCount = new Set(
          tasks.map(task =>
            task.type === 'in_process_teammate' ? task.identity.teamName : '',
          ),
        ).size
        return teamCount === 1 ? '1 team' : `${teamCount} teams`
      }
      case 'local_agent':
        return taskCount === 1 ? '1 local agent' : `${taskCount} local agents`
      case 'local_workflow':
        return taskCount === 1 ? '1 background workflow' : `${taskCount} background workflows`
      case 'monitor_mcp':
        return taskCount === 1 ? '1 monitor' : `${taskCount} monitors`
      case 'dream':
        return 'dreaming'
    }
  }

  return `${taskCount} background ${taskCount === 1 ? 'task' : 'tasks'}`
}
