import { IPC_CHANNELS } from '../../shared/constants'
import type { ExtensionHostStatus } from '../../shared/extension-host/types'
import { InvalidExtensionHostRequestError, toPublicExtensionHostError } from '../extension-host/errors'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import type { IpcBinding } from './binding'

function requireEmpty(payload: unknown): void {
  if (payload === undefined) {
    return
  }
  if (typeof payload === 'object' && payload !== null && Object.keys(payload).length === 0) {
    return
  }
  throw new InvalidExtensionHostRequestError()
}

/**
 * Extension-host IPC bindings (lifecycle controls only): exactly
 * three invoke channels (host-status, host-start, host-stop). No
 * payloads carry paths, commands, messages, or process details; the
 * renderer learns status text only. No generic spawn, send, or exec
 * surface. Registration through handleSecureIpc happens in ./index.ts.
 */
export function createExtensionHostBindings(manager: ExtensionHostManager): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.extensionsHostStatus,
      invoke: (payload): Promise<ExtensionHostStatus> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => manager.getStatus())
          .catch((error: unknown) => {
            throw toPublicExtensionHostError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsHostStart,
      invoke: (payload): Promise<ExtensionHostStatus> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => manager.start())
          .catch((error: unknown) => {
            throw toPublicExtensionHostError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsHostStop,
      invoke: (payload): Promise<ExtensionHostStatus> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => manager.stop())
          .catch((error: unknown) => {
            throw toPublicExtensionHostError(error)
          })
    }
  ]
}
