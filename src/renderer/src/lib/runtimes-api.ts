import type {
  GetActiveRuntimeRequest,
  ListRecentRuntimesRequest,
  ProjectRuntimeSummary,
  ProjectRuntimeUpdatedListener,
  RuntimeRefRequest
} from '../../../shared/project-runtime/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the project-runtimes bridge.
 * Same Electron-only availability as the bridge itself.
 */
function getRuntimesApi(): import('../../../shared/project-runtime/types').ProjectRuntimesApi | undefined {
  return getStarkApi()?.runtimes
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load the project runtime.'))
}

/**
 * Typed runtime callers. Explicit reads plus direct human Stop and
 * isolated Preview open/reload only — no polling, no timers, no
 * program/args/URL submission, no start path (starts route only
 * through approved Worker runtime_start). Main derives all
 * run/program/URL state from IDs.
 */
export function getActiveRuntime(request: GetActiveRuntimeRequest): Promise<ProjectRuntimeSummary | null> {
  const api = getRuntimesApi()?.getActive
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function listRecentRuntimes(request: ListRecentRuntimesRequest): Promise<readonly ProjectRuntimeSummary[]> {
  const api = getRuntimesApi()?.listRecent
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function stopRuntime(request: RuntimeRefRequest): Promise<ProjectRuntimeSummary> {
  const api = getRuntimesApi()?.stop
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t stop the project runtime.'))
  }
  return api(request)
}

export function openRuntimePreview(request: RuntimeRefRequest): Promise<ProjectRuntimeSummary> {
  const api = getRuntimesApi()?.openPreview
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t open the live preview.'))
  }
  return api(request)
}

export function reloadRuntimePreview(request: RuntimeRefRequest): Promise<ProjectRuntimeSummary> {
  const api = getRuntimesApi()?.reloadPreview
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t reload the live preview.'))
  }
  return api(request)
}

/**
 * Subscribes to main-pushed runtime updates (no polling). Returns an
 * unsubscribe function for effect cleanup.
 */
export function subscribeRuntimeUpdates(listener: ProjectRuntimeUpdatedListener): () => void {
  const subscribe = getRuntimesApi()?.onUpdated
  if (subscribe === undefined) {
    return () => undefined
  }
  return subscribe(listener)
}
