import { IPC_CHANNELS } from '../../shared/constants'
import type { WorkspaceCapabilityConfig } from '../../shared/capabilities/types'
import type { CapabilityService } from '../capabilities/capability-service'
import { toPublicCapabilityError } from '../capabilities/capability-errors'
import type { IpcBinding } from './binding'

/**
 * Capability IPC bindings (Stage 22): exactly two channels — read
 * and save one workspace's complete capability configuration. No
 * authorize, capability-check, execute, approve, or temporary-grant
 * surface exists. The gate stays main-internal for future tools.
 */
export function createCapabilityBindings(service: CapabilityService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.capabilitiesGetWorkspaceConfig,
      invoke: (payload): Promise<WorkspaceCapabilityConfig> =>
        Promise.resolve()
          .then(() => service.getConfig(payload))
          .catch((error: unknown) => {
            throw toPublicCapabilityError('get', error)
          })
    },
    {
      channel: IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig,
      invoke: (payload): Promise<WorkspaceCapabilityConfig> =>
        Promise.resolve()
          .then(() => service.updateConfig(payload))
          .catch((error: unknown) => {
            throw toPublicCapabilityError('update', error)
          })
    }
  ]
}
