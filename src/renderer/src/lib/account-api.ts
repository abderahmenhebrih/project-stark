import type {
  CloudAccountApi,
  CloudAccountStatus,
  StartSignInResult,
  StarkAuthProvider
} from '../../../shared/cloud-account/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the optional STARK account domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getAccountApi(): CloudAccountApi | undefined {
  return getStarkApi()?.account
}

function unavailable(message: string): Promise<never> {
  return Promise.reject(new Error(message))
}

/**
 * Typed account callers. Components use these helpers instead of
 * reaching the bridge object directly. Explicit actions only — no
 * polling, no automatic retries, no token handling.
 */
export function getAccountStatus(): Promise<CloudAccountStatus> {
  const api = getAccountApi()?.getStatus
  if (api === undefined) {
    return unavailable('Cloud account features are unavailable in this build.')
  }
  return api()
}

export function startAccountSignIn(provider: StarkAuthProvider): Promise<StartSignInResult> {
  const api = getAccountApi()?.startSignIn
  if (api === undefined) {
    return unavailable('Cloud account features are unavailable in this build.')
  }
  return api({ provider })
}

export function cancelAccountSignIn(): Promise<CloudAccountStatus> {
  const api = getAccountApi()?.cancelSignIn
  if (api === undefined) {
    return unavailable('Cloud account features are unavailable in this build.')
  }
  return api()
}

export function signOutAccount(): Promise<CloudAccountStatus> {
  const api = getAccountApi()?.signOut
  if (api === undefined) {
    return unavailable('Cloud account features are unavailable in this build.')
  }
  return api()
}

/**
 * Subscribes to trusted main→renderer account updates. The preload
 * validates every payload; invalid payloads never reach the listener.
 */
export function subscribeAccountUpdates(listener: (status: CloudAccountStatus) => void): () => void {
  const api = getAccountApi()?.onUpdated
  if (api === undefined) {
    return () => {}
  }
  return api(listener)
}
