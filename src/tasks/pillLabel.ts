import type { BackgroundTaskState } from './types.js'

export function getPillLabel(tasks: BackgroundTaskState[]): string {
  const taskCount = tasks.length
  const allSameType = tasks.every(task => task.type === tasks[0]!.type)

  if (allSameType) {
    switch (tasks[0]!.type) {
      case 'local_bash': {
        return taskCount === 1 ? '1 shell' : `${taskCount} shells`
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
      case 'dream':
        return 'dreaming'
    }
  }

  return `${taskCount} background ${taskCount === 1 ? 'task' : 'tasks'}`
}
