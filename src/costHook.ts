import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { shouldShowCostWarnings } from './utils/billing.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

/** 管理 use Cost Summary 对应的数据或状态。 */
export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    /** 执行 f 对应的业务处理。 */
    const f = () => {
      if (shouldShowCostWarnings()) {
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }

      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}
