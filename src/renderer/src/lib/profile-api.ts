import type { LocalProfile } from '../../../shared/profile/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessors for the local-profile domain API.
 * Same Electron-only availability as the bridge itself. Local display
 * preference only — never synchronized to Supabase.
 */
export function getLocalProfile(): Promise<LocalProfile | null> {
  const api = getStarkApi()?.profile.get
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t load your profile.'))
  }
  return api()
}

export function updateLocalDisplayName(displayName: string): Promise<LocalProfile> {
  const api = getStarkApi()?.profile.setDisplayName
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t save your name.'))
  }
  return api(displayName)
}
