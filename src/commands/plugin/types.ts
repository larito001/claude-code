import type { LocalJSXCommandOnDone } from '../../types/command.js'

type ViewStateBase = {
  targetMarketplace?: string
  targetPlugin?: string
  action?: 'enable' | 'disable' | 'uninstall' | 'update' | 'remove'
  initialValue?: string
}

export type ViewState = ViewStateBase &
  (
    | { type: 'menu' }
    | { type: 'help' }
    | { type: 'validate'; path: string }
    | { type: 'browse-marketplace' }
    | { type: 'discover-plugins' }
    | { type: 'manage-plugins' }
    | { type: 'marketplace-list' }
    | { type: 'add-marketplace' }
    | { type: 'manage-marketplaces' }
    | { type: 'marketplace-menu' }
  )

export type PluginSettingsProps = {
  onComplete: LocalJSXCommandOnDone
  args?: string
}
