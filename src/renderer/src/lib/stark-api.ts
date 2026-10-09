import type { ProfileApi } from '../../../shared/profile/types'
import type { SettingsApi } from '../../../shared/settings/types'
import type { StarkApi } from '../../../shared/types'
import type { WorkspaceApi } from '../../../shared/workspace/types'
import type {
  WorkspaceFilesApi,
  WorkspaceTextFileWriteRequest,
  WorkspaceTextFileWriteResult
} from '../../../shared/workspace-files/types'
import type { WorkspaceSearchRequest, WorkspaceSearchResult } from '../../../shared/workspace-search/types'
import type {
  ExtensionInstallIdentity,
  ExtensionSearchRequest,
  ExtensionSearchResult,
  InstalledExtensionEntry,
  UninstalledExtensionEntry
} from '../../../shared/extension-registry/types'
import type { ExtensionHostStatus } from '../../../shared/extension-host/types'

/**
 * Typed accessor for the preload bridge.
 * Returns undefined when the renderer runs outside Electron
 * (for example a plain Vite preview), so callers can fall back.
 */
export function getStarkApi(): StarkApi | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  return window.stark
}

/**
 * Typed accessor for the Settings domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getSettingsApi(): SettingsApi | undefined {
  return getStarkApi()?.settings
}

/**
 * Typed accessor for the local-profile domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getProfileApi(): ProfileApi | undefined {
  return getStarkApi()?.profile
}

/**
 * Typed accessor for the Workspace domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getWorkspaceApi(): WorkspaceApi | undefined {
  return getStarkApi()?.workspace
}

/**
 * Typed accessor for the workspace-files domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getWorkspaceFilesApi(): WorkspaceFilesApi | undefined {
  return getStarkApi()?.workspace.files
}

/**
 * Typed workspace-search caller.
 *
 * Search lives directly on the workspace bridge as `workspace.search`
 * (no double naming); this helper keeps components free of direct
 * `window.stark` access and mirrors the existing accessor pattern.
 */
/**
 * Typed stale-safe single-file save caller.
 *
 * Keeps components free of direct `window.stark` access, mirroring the
 * search helper above. The caller supplies the persisted workspace id,
 * the relative path, the revision it read, and the new content.
 */
export function writeWorkspaceTextFile(
  request: WorkspaceTextFileWriteRequest
): Promise<WorkspaceTextFileWriteResult> {
  const api = getStarkApi()?.workspace.files.writeTextFile
  if (api === undefined) {
    return Promise.reject(new Error('Workspace file saving is unavailable.'))
  }
  return api(request)
}

export function searchWorkspace(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult> {
  const api = getStarkApi()?.workspace.search
  if (api === undefined) {
    return Promise.reject(new Error('Workspace search is unavailable.'))
  }
  return api(request)
}

/**
 * Typed extension-catalog callers.
 *
 * The panel never touches the registry directly: these helpers reach
 * the main-owned service through the fixed preload bridge (fixed
 * Open VSX origin, bounded requests). Unavailable outside Electron.
 */
export function searchExtensionCatalog(request: ExtensionSearchRequest): Promise<ExtensionSearchResult> {
  const api = getStarkApi()?.extensions.search
  if (api === undefined) {
    return Promise.reject(new Error('Extension catalog is unavailable.'))
  }
  return api(request)
}

export function listFeaturedExtensions(): Promise<ExtensionSearchResult> {
  const api = getStarkApi()?.extensions.listFeatured
  if (api === undefined) {
    return Promise.reject(new Error('Extension catalog is unavailable.'))
  }
  return api()
}

/**
 * Typed extension-install callers (store only, never execute).
 *
 * The panel supplies normalized identity only; download, paths, and
 * validation are main-owned through the fixed preload bridge.
 */
export function installExtension(identity: ExtensionInstallIdentity): Promise<InstalledExtensionEntry> {
  const api = getStarkApi()?.extensions.install
  if (api === undefined) {
    return Promise.reject(new Error('Extension installation is unavailable.'))
  }
  return api(identity)
}

export function listInstalledExtensions(): Promise<readonly InstalledExtensionEntry[]> {
  const api = getStarkApi()?.extensions.listInstalled
  if (api === undefined) {
    return Promise.reject(new Error('Extension installation is unavailable.'))
  }
  return api()
}

export function uninstallExtension(identity: ExtensionInstallIdentity): Promise<UninstalledExtensionEntry> {
  const api = getStarkApi()?.extensions.uninstall
  if (api === undefined) {
    return Promise.reject(new Error('Extension installation is unavailable.'))
  }
  return api(identity)
}

/**
 * Typed Extension Host controls (foundation only: status text in,
 * start/stop out). No process details ever reach the renderer.
 */
export function getExtensionHostStatus(): Promise<ExtensionHostStatus> {
  const api = getStarkApi()?.extensionHost.hostStatus
  if (api === undefined) {
    return Promise.reject(new Error('Extension Host is unavailable.'))
  }
  return api()
}

export function startExtensionHost(): Promise<ExtensionHostStatus> {
  const api = getStarkApi()?.extensionHost.startHost
  if (api === undefined) {
    return Promise.reject(new Error('Extension Host is unavailable.'))
  }
  return api()
}

export function stopExtensionHost(): Promise<ExtensionHostStatus> {
  const api = getStarkApi()?.extensionHost.stopHost
  if (api === undefined) {
    return Promise.reject(new Error('Extension Host is unavailable.'))
  }
  return api()
}
