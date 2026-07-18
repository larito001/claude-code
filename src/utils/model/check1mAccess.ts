import { is1mContextDisabled } from '../context.js'

// API-key providers control extended-context entitlement. Locally we only
// honor the explicit kill switch and let the provider validate the model.
export function checkOpus1mAccess(): boolean {
  return !is1mContextDisabled()
}

export function checkSonnet1mAccess(): boolean {
  return !is1mContextDisabled()
}
