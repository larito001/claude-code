import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../ink.js';
import { calculateTokenWarningState, isAutoCompactEnabled } from '../services/compact/autoCompact.js';
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js';
type Props = {
  tokenUsage: number;
  model: string;
};

export function TokenWarning(t0) {
  const $ = _c(13);
  const {
    tokenUsage,
    model
  } = t0;
  let t1;
  if ($[0] !== model || $[1] !== tokenUsage) {
    t1 = calculateTokenWarningState(tokenUsage, model);
    $[0] = model;
    $[1] = tokenUsage;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold
  } = t1;
  const suppressWarning = useCompactWarningSuppression();
  if (!isAboveWarningThreshold || suppressWarning) {
    return null;
  }
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = isAutoCompactEnabled();
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const showAutoCompactWarning = t2;
  const autocompactLabel = `${percentLeft}% until auto-compact`;
  let t4;
  if ($[9] !== autocompactLabel || $[10] !== isAboveErrorThreshold || $[11] !== percentLeft) {
    t4 = <Box flexDirection="row">{showAutoCompactWarning ? <Text dimColor={true} wrap="truncate">{autocompactLabel}</Text> : <Text color={isAboveErrorThreshold ? "error" : "warning"} wrap="truncate">{`Context low (${percentLeft}% remaining) \u00b7 Run /compact to compact & continue`}</Text>}</Box>;
    $[9] = autocompactLabel;
    $[10] = isAboveErrorThreshold;
    $[11] = percentLeft;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  return t4;
}
