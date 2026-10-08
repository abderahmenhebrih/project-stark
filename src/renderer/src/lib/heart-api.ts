import type { HeartConfig, HeartWorkerMode, HeartWorkerProfile } from '../../../shared/heart/types'
import { getStarkApi } from './stark-api'
import type { HeartApi } from '../../../shared/heart/types'
import type { UpdateHeartConfigRequest } from '../../../shared/heart/types'

/**
 * Typed accessor for the Heart domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getHeartApi(): HeartApi | undefined {
  return getStarkApi()?.heart
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load the Heart configuration.'))
}

/**
 * Typed Heart callers. Components use these helpers instead of
 * reaching the bridge object directly. Explicit save only — no
 * autosave, no background refresh.
 */
export function getHeartConfig(): Promise<HeartConfig | null> {
  const api = getHeartApi()?.get
  if (api === undefined) {
    return unavailable()
  }
  return api()
}

export function saveHeartConfig(config: UpdateHeartConfigRequest): Promise<HeartConfig> {
  const api = getHeartApi()?.update
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t save the Heart configuration.'))
  }
  return api(config)
}

export const HEART_WORKER_PROFILES: readonly HeartWorkerProfile[] = ['general', 'coding', 'reasoning', 'fast']

export type HeartWorkerModeSelection = HeartWorkerMode
