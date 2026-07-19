import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from 'src/utils/log.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getMaxVersion, getMaxVersionMessage } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { installLatest } from '../utils/nativeInstaller/index.js';
import { gt } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function NativeAutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    current?: string | null;
    latest?: string | null;
  }>({});
  const [maxVersionIssue, setMaxVersionIssue] = useState<string | null>(null);
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';

  // Track latest isUpdating value in a ref so the memoized checkForUpdates
  // callback always sees the current value without changing callback identity
  // (which would re-trigger the initial-check useEffect below and cause
  // repeated downloads on remount — the upstream trigger for #22413).
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;
  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }
    if ("production" === 'test' || "production" === 'development') {
      logForDebugging('NativeAutoUpdater: Skipping update check in test/dev environment');
      return;
    }
    if (isAutoUpdaterDisabled()) {
      return;
    }
    onChangeIsUpdating(true);
    try {
      // Check if current version is above the max allowed version
      const maxVersion = await getMaxVersion();
      if (maxVersion && gt(MACRO.VERSION, maxVersion)) {
        const msg = await getMaxVersionMessage();
        setMaxVersionIssue(msg ?? 'affects your version');
      }
      const result = await installLatest(channel);
      const currentVersion = MACRO.VERSION;
      // Handle lock contention gracefully - just return without treating as error
      if (result.lockFailed) {
        return; // Silently skip this update check, will try again later
      }

      // Update versions for display
      setVersions({
        current: currentVersion,
        latest: result.latestVersion
      });
      if (result.wasUpdated) {
        onAutoUpdaterResult({
          version: result.latestVersion,
          status: 'success'
        });
      }
    } catch (error) {
      logError(error);
      onAutoUpdaterResult({
        version: null,
        status: 'install_failed'
      });
    } finally {
      onChangeIsUpdating(false);
    }
    // isUpdating intentionally omitted from deps; we read isUpdatingRef
    // instead so the guard is always current without changing callback
    // identity (which would re-trigger the initial-check useEffect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: isUpdating read via ref
  }, [onAutoUpdaterResult, channel]);

  // Initial check
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // Check every 30 minutes
  useInterval(checkForUpdates, 30 * 60 * 1000);
  const hasUpdateResult = !!autoUpdaterResult?.version;
  const hasVersionInfo = !!versions.current && !!versions.latest;
  // Show the component when:
  // - warning banner needed (above max version), or
  // - there's an update result to display (success/error), or
  // - actively checking and we have version info to show
  const shouldRender = !!maxVersionIssue || hasUpdateResult || isUpdating && hasVersionInfo;
  if (!shouldRender) {
    return null;
  }
  return <Box flexDirection="row" gap={1}>
      {verbose && <Text dimColor wrap="truncate">
          current: {versions.current} &middot; {channel}: {versions.latest}
        </Text>}
      {isUpdating ? <Box>
          <Text dimColor wrap="truncate">
            Checking for updates
          </Text>
        </Box> : autoUpdaterResult?.status === 'success' && showSuccessMessage && updateSemver && <Text color="success" wrap="truncate">
            ✓ Update installed · Restart to update
          </Text>}
      {autoUpdaterResult?.status === 'install_failed' && <Text color="error" wrap="truncate">
          ✗ Auto-update failed &middot; Try <Text bold>/status</Text>
        </Text>}
      {maxVersionIssue && <Text color="warning">
          ⚠ Known issue: {maxVersionIssue} &middot; Install a supported version
        </Text>}
    </Box>;
}
