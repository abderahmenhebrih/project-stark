import { IPC_CHANNELS } from '../../shared/constants'
import type { InstalledExtensionEntry, UninstalledExtensionEntry } from '../../shared/extension-registry/types'
import { InvalidExtensionInstallRequestError, toPublicExtensionInstallError, toPublicExtensionStateError } from '../extension-install/errors'
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

/**
 * Strict setEnabled payload: exactly identity plus a boolean flag.
 * No paths, no URLs, no metadata authority of any kind.
 */
function readSetEnabledRequest(payload: unknown): { namespace: string; name: string; version: string; enabled: boolean } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionInstallRequestError()
  }
  const keys = Object.keys(payload)
  if (
    keys.length !== 4 ||
    !keys.includes('namespace') ||
    !keys.includes('name') ||
    !keys.includes('version') ||
    !keys.includes('enabled')
  ) {
    throw new InvalidExtensionInstallRequestError()
  }
  const identity = validatedInstallIdentity({
    namespace: (payload as Record<string, unknown>)['namespace'],
    name: (payload as Record<string, unknown>)['name'],
    version: (payload as Record<string, unknown>)['version']
  })
  const enabled = (payload as Record<string, unknown>)['enabled']
  if (typeof enabled !== 'boolean') {
    throw new InvalidExtensionInstallRequestError()
  }
  return { ...identity, enabled }
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
 * four invoke channels (install, list-installed, uninstall,
 * set-enabled). The renderer supplies normalized identity only (plus
 * one boolean for setEnabled) — destinations, URLs, paths, and state
 * files are all main-derived. No generic download/unzip/write,
 * settings-mutation, or delete surface. Registration through
 * handleSecureIpc happens in ./index.ts.
 *
 * The optional hooks let the formatter pilot unload on disable /
 * uninstall (best-effort host stop; future formats re-check enabled
 * state regardless). They default to no-ops so older harnesses and
 * unit tests are unaffected.
 */
export interface ExtensionInstallHooks {
  readonly onEnabledStateChanged?: (identity: { namespace: string; name: string; version: string }, enabled: boolean) => void
  readonly onUninstalled?: (identity: { namespace: string; name: string; version: string }) => void
  /**
   * Runs BEFORE the files are removed: deactivates the exact
   * instance when active (bounded DEACTIVATE + disposal), stopping
   * the owned host when a clean deactivate cannot be established.
   * Failures never block the safe uninstall itself (the host stop
   * already unloaded modules). Defaults to a no-op so older
   * harnesses stay unaffected.
   */
  readonly beforeUninstall?: (identity: { namespace: string; name: string; version: string }) => Promise<void>
}

function notify(hook: (() => void) | undefined): void {
  if (hook === undefined) {
    return
  }
  try {
    hook()
  } catch {
    // Hook failures must never break install/uninstall results.
  }
}

export function createExtensionInstallBindings(
  service: ExtensionInstallService,
  hooks?: ExtensionInstallHooks
): readonly IpcBinding[] {
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
          .then((identity) =>
            Promise.resolve()
              .then(() => hooks?.beforeUninstall?.({ namespace: identity.namespace, name: identity.name, version: identity.version }))
              .catch(() => undefined)
              .then(() => service.uninstall(identity))
              .then((result) => {
                if (result.status === 'uninstalled') {
                  const hook = hooks?.onUninstalled
                  if (hook !== undefined) {
                    notify(() => hook({ namespace: identity.namespace, name: identity.name, version: identity.version }))
                  }
                }
                return result
              })
          )
          .catch((error: unknown) => {
            throw toPublicExtensionInstallError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsSetEnabled,
      invoke: (payload): Promise<InstalledExtensionEntry> =>
        Promise.resolve()
          .then(() => readSetEnabledRequest(payload))
          .then((request) =>
            service
              .setEnabled(
                { namespace: request.namespace, name: request.name, version: request.version },
                request.enabled
              )
              .then((entry) => {
                const hook = hooks?.onEnabledStateChanged
                if (hook !== undefined) {
                  notify(() =>
                    hook(
                      { namespace: request.namespace, name: request.name, version: request.version },
                      request.enabled
                    )
                  )
                }
                return entry
              })
          )
          .catch((error: unknown) => {
            throw toPublicExtensionStateError(error)
          })
    }
  ]
}
