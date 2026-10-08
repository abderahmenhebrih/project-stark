import type { RecoveryAssignment, RecoveryConfig, RecoveryEvent, RecoveryMode } from '../../../shared/recovery/types'
import { getStarkApi } from './stark-api'
import type { RecoveryApi, RecoveryForSourceRequest, RecoveryForTargetRequest, UpdateRecoveryConfigRequest } from '../../../shared/recovery/types'

/**
 * Typed accessor for the Recovery domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getRecoveryApi(): RecoveryApi | undefined {
  return getStarkApi()?.recovery
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load the recovery configuration.'))
}

/**
 * Typed Recovery callers. Components use these helpers instead of
 * reaching the bridge object directly. Explicit save only — no
 * autosave, no background model tests, no polling.
 */
export function getRecoveryConfig(): Promise<RecoveryConfig | null> {
  const api = getRecoveryApi()?.getConfig
  if (api === undefined) {
    return unavailable()
  }
  return api()
}

export function saveRecoveryConfig(config: UpdateRecoveryConfigRequest): Promise<RecoveryConfig> {
  const api = getRecoveryApi()?.updateConfig
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t save the recovery configuration.'))
  }
  return api(config)
}

export type RecoveryModeSelection = RecoveryMode

export function recoveryPolicyCopy(mode: RecoveryMode): string {
  switch (mode) {
    case 'off':
      return 'Off'
    case 'handoff':
      return 'Handoff only'
    case 'auto_once':
      return 'Auto once'
  }
}

export function emptyRecoveryAssignment(): RecoveryAssignment {
  return { providerId: 'openai', model: '' }
}

export function getRecoveryForTarget(request: RecoveryForTargetRequest): Promise<RecoveryEvent | null> {
  const api = getRecoveryApi()?.getForTarget
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t load the recovery state.'))
  }
  return api(request)
}

export function getRecoveryForSource(request: RecoveryForSourceRequest): Promise<RecoveryEvent | null> {
  const api = getRecoveryApi()?.getForSource
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t load the recovery state.'))
  }
  return api(request)
}

export function dismissRecovery(request: RecoveryForTargetRequest): Promise<RecoveryEvent> {
  const api = getRecoveryApi()?.dismiss
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t dismiss this recovery.'))
  }
  return api(request)
}
