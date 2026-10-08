import type {
  ListOrchestrationRunsRequest,
  OrchestrationRun,
  OrchestrationRunRequest
} from '../../../shared/orchestration/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the orchestration domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getOrchestrationApi(): import('../../../shared/orchestration/types').OrchestrationApi | undefined {
  return getStarkApi()?.orchestration
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load work runs.'))
}

/**
 * Typed orchestration callers. Components use these helpers instead of
 * reaching the bridge object directly. Read-only run history; runs
 * themselves start through the AI bridge. No polling here — callers
 * fetch explicitly.
 */
export function getOrchestrationRun(request: OrchestrationRunRequest): Promise<OrchestrationRun> {
  const api = getOrchestrationApi()?.get
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function listRecentOrchestrationRuns(request: ListOrchestrationRunsRequest): Promise<readonly OrchestrationRun[]> {
  const api = getOrchestrationApi()?.listRecent
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}
