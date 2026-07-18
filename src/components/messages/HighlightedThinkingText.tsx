import figures from 'figures';
import * as React from 'react';
import { useContext } from 'react';
import { Text } from '../../ink.js';
import { findThinkingTriggerPositions, getRainbowColor, isUltrathinkEnabled } from '../../utils/thinking.js';
import { MessageActionsSelectedContext } from '../messageActions.js';

type Props = {
  text: string;
};

export function HighlightedThinkingText({ text }: Props): React.ReactNode {
  const isSelected = useContext(MessageActionsSelectedContext);
  const pointerColor = isSelected ? 'suggestion' : 'subtle';
  const triggers = isUltrathinkEnabled() ? findThinkingTriggerPositions(text) : [];

  if (triggers.length === 0) {
    return <Text><Text color={pointerColor}>{figures.pointer} </Text><Text color="text">{text}</Text></Text>;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const trigger of triggers) {
    if (trigger.start > cursor) {
      parts.push(<Text key={`plain-${cursor}`} color="text">{text.slice(cursor, trigger.start)}</Text>);
    }
    for (let i = trigger.start; i < trigger.end; i++) {
      parts.push(<Text key={`rb-${i}`} color={getRainbowColor(i - trigger.start)}>{text[i]}</Text>);
    }
    cursor = trigger.end;
  }
  if (cursor < text.length) {
    parts.push(<Text key={`plain-${cursor}`} color="text">{text.slice(cursor)}</Text>);
  }
  return <Text><Text color={pointerColor}>{figures.pointer} </Text>{parts}</Text>;
}
