import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { truncate } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { formatModelAndBilling, getLogoDisplayData, truncatePath } from '../../utils/logoV2Utils.js';
import { renderModelSetting } from '../../utils/model/model.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { AnimatedClawd } from './AnimatedClawd.js';
import { Clawd } from './Clawd.js';
export function CondensedLogo() {
  const $ = _c(29);
  const {
    columns
  } = useTerminalSize();
  const agent = useAppState(_temp);
  const effortValue = useAppState(_temp2);
  const model = useMainLoopModel();
  const modelDisplayName = renderModelSetting(model);
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings
  } = getLogoDisplayData();
  const agentName = agent ?? agentNameFromSettings;  const textWidth = Math.max(columns - 15, 20);
  const truncatedVersion = truncate(version, Math.max(textWidth - 13, 6));
  const effortSuffix = getEffortSuffix(model, effortValue);
  const {
    shouldSplit,
    truncatedModel,
    truncatedBilling
  } = formatModelAndBilling(modelDisplayName + effortSuffix, billingType, textWidth);
  const cwdAvailableWidth = agentName ? textWidth - 1 - stringWidth(agentName) - 3 : textWidth;
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text bold={true}>Claude Code</Text>;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== truncatedVersion) {
    t6 = <Text>{t5}{" "}<Text dimColor={true}>v{truncatedVersion}</Text></Text>;
    $[9] = truncatedVersion;
    $[10] = t6;
  } else {
    t6 = $[10];
  }
  let t7;
  if ($[11] !== shouldSplit || $[12] !== truncatedBilling || $[13] !== truncatedModel) {
    t7 = shouldSplit ? <><Text dimColor={true}>{truncatedModel}</Text><Text dimColor={true}>{truncatedBilling}</Text></> : <Text dimColor={true}>{truncatedModel} · {truncatedBilling}</Text>;
    $[11] = shouldSplit;
    $[12] = truncatedBilling;
    $[13] = truncatedModel;
    $[14] = t7;
  } else {
    t7 = $[14];
  }
  const t8 = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd;
  let t9;
  if ($[15] !== t8) {
    t9 = <Text dimColor={true}>{t8}</Text>;
    $[15] = t8;
    $[16] = t9;
  } else {
    t9 = $[16];
  }
  return <OffscreenFreeze><Box flexDirection="row" gap={2} alignItems="center">{t4}<Box flexDirection="column">{t6}{t7}{t9}</Box></Box></OffscreenFreeze>;
}
function _temp2(s_0) {
  return s_0.effortValue;
}
function _temp(s) {
  return s.agent;
}
