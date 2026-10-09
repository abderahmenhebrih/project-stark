import type { UsageApi, UsageConfig, UsageSummary, UpdateUsageConfigRequest } from '../../../shared/usage/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the local usage-awareness domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getUsageApi(): UsageApi | undefined {
  return getStarkApi()?.usage
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load the local usage summary.'))
}

/**
 * Typed usage callers. Components use these helpers instead of
 * reaching the bridge object directly. Explicit save/refresh only —
 * no autosave, no polling, no provider calls.
 */
export function getUsageConfig(): Promise<UsageConfig> {
  const api = getUsageApi()?.getConfig
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t load the usage configuration.'))
  }
  return api()
}

export function saveUsageConfig(config: UpdateUsageConfigRequest): Promise<UsageConfig> {
  const api = getUsageApi()?.updateConfig
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t save the usage routing configuration.'))
  }
  return api(config)
}

export function getUsageSummary(): Promise<UsageSummary> {
  const api = getUsageApi()?.getSummary
  if (api === undefined) {
    return unavailable()
  }
  return api()
}
