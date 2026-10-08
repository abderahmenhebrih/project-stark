import type {
  CapabilitiesApi,
  GetWorkspaceCapabilityConfigRequest,
  UpdateWorkspaceCapabilityConfigRequest,
  WorkspaceCapabilityConfig
} from '../../../shared/capabilities/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the Capabilities domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getCapabilitiesApi(): CapabilitiesApi | undefined {
  return getStarkApi()?.capabilities
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load the workspace permissions.'))
}

/**
 * Typed capability callers. Components use these helpers instead of
 * reaching the bridge object directly. Explicit save only — no
 * autosave, no polling, no tool execution.
 */
export function getWorkspaceCapabilityConfig(request: GetWorkspaceCapabilityConfigRequest): Promise<WorkspaceCapabilityConfig> {
  const api = getCapabilitiesApi()?.getWorkspaceConfig
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function saveWorkspaceCapabilityConfig(config: UpdateWorkspaceCapabilityConfigRequest): Promise<WorkspaceCapabilityConfig> {
  const api = getCapabilitiesApi()?.updateWorkspaceConfig
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t save the workspace permissions.'))
  }
  return api(config)
}
