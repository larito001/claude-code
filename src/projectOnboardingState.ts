import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isDirEmpty } from './utils/file.js'
import { getFsImplementation } from './utils/fsOperations.js'

export type Step = {
  key: string
  text: string
  isComplete: boolean
  isCompletable: boolean
  isEnabled: boolean
}

/** 获取 get Steps 对应的数据或状态。 */
export function getSteps(): Step[] {
  const hasClaudeMd = getFsImplementation().existsSync(
    join(getCwd(), 'CLAUDE.md'),
  )
  const isWorkspaceDirEmpty = isDirEmpty(getCwd())

  return [
    {
      key: 'workspace',
      text: 'Ask Claude to create a new app or clone a repository',
      isComplete: false,
      isCompletable: true,
      isEnabled: isWorkspaceDirEmpty,
    },
    {
      key: 'claudemd',
      text: 'Run /init to create a CLAUDE.md file with instructions for Claude',
      isComplete: hasClaudeMd,
      isCompletable: true,
      isEnabled: !isWorkspaceDirEmpty,
    },
  ]
}

/** 判断是否满足 is Project Onboarding Complete 对应的数据或状态。 */
export function isProjectOnboardingComplete(): boolean {
  return getSteps()
    .filter(({ isCompletable, isEnabled }) => isCompletable && isEnabled)
    .every(({ isComplete }) => isComplete)
}

/** 执行 maybe Mark Project Onboarding Complete 对应的业务处理。 */
export function maybeMarkProjectOnboardingComplete(): void {
  // 在缓存的配置上短路——isProjectOnboardingComplete() 访问文件系统，而 REPL.tsx 每次提交提示时都会调用它。
  if (getCurrentProjectConfig().hasCompletedProjectOnboarding) {
    return
  }
  if (isProjectOnboardingComplete()) {
    saveCurrentProjectConfig(current => ({
      ...current,
      hasCompletedProjectOnboarding: true,
    }))
  }
}

/** 判断是否满足 should Show Project Onboarding 对应的数据或状态。 */
export const shouldShowProjectOnboarding = memoize((): boolean => {
  const projectConfig = getCurrentProjectConfig()
  // 在 isProjectOnboardingComplete() 访问文件系统之前，对缓存的配置短路——这会在首次渲染期间运行。
  if (
    projectConfig.hasCompletedProjectOnboarding ||
    projectConfig.projectOnboardingSeenCount >= 4 ||
    process.env.IS_DEMO
  ) {
    return false
  }

  return !isProjectOnboardingComplete()
})

/** 执行 increment Project Onboarding Seen Count 对应的业务处理。 */
export function incrementProjectOnboardingSeenCount(): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    projectOnboardingSeenCount: current.projectOnboardingSeenCount + 1,
  }))
}
