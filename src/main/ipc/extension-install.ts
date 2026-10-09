import { IPC_CHANNELS } from '../../shared/constants'
import type { InstalledExtensionEntry, UninstalledExtensionEntry } from '../../shared/extension-registry/types'
import { InvalidExtensionInstallRequestError, toPublicExtensionInstallError } from '../extension-install/errors'
import { validatedInstallIdentity } from '../extension-install/extension-install-service'
import type { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { IpcBinding } from './binding'

function readIdentity(payload: unknown): { namespace: string; name: string; version: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionInstallRequestError()
  }
  const keys = Object.keys(payload)
  if (keys.length !== 3 || !keys.includes('namespace') || !keys.includes('name') || !keys.includes('version')) {
    throw new InvalidExtensionInstallRequestError()
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
  throw new InvalidExtensionInstallRequestError()
}

/**
 * Extension-install IPC bindings (store only, never execute): exactly
 * three invoke channels (install, list-installed, uninstall). The
 * renderer supplies normalized identity only — destinations, URLs,
 * and paths are all main-derived. No generic download/unzip/write
 * or delete surface. Registration through handleSecureIpc happens in
 * ./index.ts.
 */
export function createExtensionInstallBindings(service: ExtensionInstallService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.extensionsInstall,
      invoke: (payload): Promise<InstalledExtensionEntry> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) => service.install(identity))
          .catch((error: unknown) => {
            throw toPublicExtensionInstallError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListInstalled,
      invoke: (payload): Promise<readonly InstalledExtensionEntry[]> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => service.listInstalled())
          .catch((error: unknown) => {
            throw toPublicExtensionInstallError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsUninstall,
      invoke: (payload): Promise<UninstalledExtensionEntry> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) => service.uninstall(identity))
          .catch((error: unknown) => {
            throw toPublicExtensionInstallError(error)
          })
    }
  ]
}
