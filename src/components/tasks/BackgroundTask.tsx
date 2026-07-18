import * as React from 'react';
import { Text } from 'src/ink.js';
import type { BackgroundTaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { truncate } from 'src/utils/format.js';
import { toInkColor } from 'src/utils/ink.js';
import { plural } from 'src/utils/stringUtils.js';
import { ShellProgress, TaskStatusText } from './ShellProgress.js';
import { describeTeammateActivity } from './taskStatusUtils.js';

type Props = {
  task: DeepImmutable<BackgroundTaskState>;
  maxActivityWidth?: number;
};

function CompletionStatus({ task }: { task: DeepImmutable<BackgroundTaskState> }): React.ReactNode {
  return <TaskStatusText
    status={task.status}
    label={task.status === 'completed' ? 'done' : undefined}
    suffix={task.status === 'completed' && !task.notified ? ', unread' : undefined}
  />;
}

export function BackgroundTask({ task, maxActivityWidth = 40 }: Props): React.ReactNode {
  switch (task.type) {
    case 'local_bash': {
      const activity = task.kind === 'monitor' ? task.description : task.command;
      return <Text>{truncate(activity, maxActivityWidth, true)} <ShellProgress shell={task} /></Text>;
    }
    case 'local_agent':
      return <Text>{truncate(task.description, maxActivityWidth, true)} <CompletionStatus task={task} /></Text>;
    case 'in_process_teammate': {
      const activity = truncate(describeTeammateActivity(task), maxActivityWidth, true);
      return <Text><Text color={toInkColor(task.identity.color)}>@{task.identity.agentName}</Text><Text dimColor>: {activity}</Text></Text>;
    }
    case 'dream': {
      const filesTouched = task.filesTouched.length;
      const detail = task.phase === 'updating' && filesTouched > 0
        ? `${filesTouched} ${plural(filesTouched, 'file')}`
        : `${task.sessionsReviewing} ${plural(task.sessionsReviewing, 'session')}`;
      return <Text>{task.description} <Text dimColor>· {task.phase} · {detail}</Text> <CompletionStatus task={task} /></Text>;
    }
  }
}
