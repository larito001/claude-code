import * as React from 'react';
import { useMemoryUsage } from '../hooks/useMemoryUsage.js';
import { Box, Text } from '../ink.js';
import { formatFileSize } from '../utils/format.js';
export function MemoryUsageIndicator(): React.ReactNode {
  const memoryUsage = useMemoryUsage();
  if (!memoryUsage) {
    return null;
  }
  const {
    heapUsed,
    status
  } = memoryUsage;

  // Only show indicator when memory usage is high or critical
  if (status === 'normal') {
    return null;
  }
  const formattedSize = formatFileSize(heapUsed);
  const color = status === 'critical' ? 'error' : 'warning';
  return <Box>
      <Text color={color} wrap="truncate">
        High memory usage ({formattedSize})
      </Text>
    </Box>;
}
