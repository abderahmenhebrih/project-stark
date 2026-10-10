import { IPC_CHANNELS } from '../../shared/constants'
import type { ExtensionActivationResult, ExtensionDeactivationResult } from '../../shared/extension-host/types'
import {
  InvalidExtensionActivationRequestError,
  toPublicExtensionActivationError
} from '../extension-host/extension-activation-errors'
import type { ExtensionActivationService } from '../extension-host/extension-activation-service'
import { validatedInstallIdentity } from '../extension-install/extension-install-service'
import type { IpcBinding } from './binding'

function readIdentity(payload: unknown): { namespace: string; name: string; version: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const keys = Object.keys(payload)
  if (keys.length !== 3 || !keys.includes('namespace') || !keys.includes('name') || !keys.includes('version')) {
    throw new InvalidExtensionActivationRequestError()
  }
  return validatedInstallIdentity(payload)
}

function requireEmpty(payload: unknown): void {
  if (payload === undefined) {
    return
  }
  if (typeof payload === 'object' && payload !== null && Object.keys(payload).length === 0) {
    return
  }
  throw new InvalidExtensionActivationRequestError()
}

/**
 * Generic extension-activation IPC bindings (demand-driven only).
 *
 * Exactly three invoke channels (activate, deactivate, list-active).
 * The renderer supplies normalized identity only — never filesystem
 * paths, never manifest authority. Main verifies installed + enabled
 * + manifest + entrypoint, then activates inside the isolated host
 * with bounded timeouts (10s activate, 5s deactivate), single flight
 * per instance, no retry, no polling, no startup sweep. No generic
 * spawn, send, exec, or write surface. Registration through
 * handleSecureIpc happens in ./index.ts.
 */
export function createExtensionActivationBindings(service: ExtensionActivationService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.extensionsActivate,
      invoke: (payload): Promise<ExtensionActivationResult> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) => service.activateExtension(identity))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsDeactivate,
      invoke: (payload): Promise<ExtensionDeactivationResult> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) =>
            service.deactivateExtension(identity).then((deactivated) => ({
              extensionId: `${identity.namespace}.${identity.name}@${identity.version}`,
              deactivated
            }))
          )
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListActive,
      invoke: (payload): Promise<readonly string[]> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => service.listActive())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    }
  ]
}
