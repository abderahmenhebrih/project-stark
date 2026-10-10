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
import type {
  ExtensionActivationIdentity,
  ExtensionActivationResult,
  ExtensionDeactivationResult,
  ExtensionHostStatus
} from '../../../shared/extension-host/types'
import type {
  ExtensionDetails,
  ExtensionDiagnostic,
  ExtensionDocumentEvent,
  ExtensionEditProposal,
  ExtensionIdentity,
  ExtensionIconTheme,
  ExtensionLanguage,
  ExtensionManagementApi,
  ExtensionNotification,
  ExtensionPrompt,
  ExtensionPromptResolution,
  ExtensionProviderQuery,
  ExtensionSnippet,
  ExtensionStatusItem,
  ExtensionThemeData,
  ExtensionTrigger,
  ExtensionTriggerOutcome,
  ExtensionUpdateCheck,
  ExtensionCommand,
  ExtensionJsonSchema,
  SelectedThemeRef
} from '../../../shared/extension-management/types'

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
 * Typed enable/disable caller (management state only, never execution).
 *
 * Sends normalized identity plus the desired flag; persistence is
 * main-owned through the fixed preload bridge.
 */
export function setExtensionEnabled(identity: ExtensionInstallIdentity, enabled: boolean): Promise<InstalledExtensionEntry> {
  const api = getStarkApi()?.extensions.setEnabled
  if (api === undefined) {
    return Promise.reject(new Error('Extension installation is unavailable.'))
  }
  return api({ ...identity, enabled })
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

/**
 * Typed generic activation callers (identity only, never paths).
 *
 * Demand-driven: activation runs an extension inside the isolated
 * host on explicit STARK feature requests. Enabled means allowed,
 * never running.
 */
export function activateExtension(identity: ExtensionActivationIdentity): Promise<ExtensionActivationResult> {
  const api = getStarkApi()?.extensionActivation.activate
  if (api === undefined) {
    return Promise.reject(new Error('Extension activation is unavailable.'))
  }
  return api(identity)
}

export function deactivateExtension(identity: ExtensionActivationIdentity): Promise<ExtensionDeactivationResult> {
  const api = getStarkApi()?.extensionActivation.deactivate
  if (api === undefined) {
    return Promise.reject(new Error('Extension activation is unavailable.'))
  }
  return api(identity)
}

export function listActiveExtensions(): Promise<readonly string[]> {
  const api = getStarkApi()?.extensionActivation.listActive
  if (api === undefined) {
    return Promise.reject(new Error('Extension activation is unavailable.'))
  }
  return api()
}

function getExtensionManagementApi(): ExtensionManagementApi | undefined {
  return getStarkApi()?.extensionManagement
}

/**
 * Typed extension-management callers (details, trust, triggers,
 * palette, providers, diagnostics, output, proposals, config,
 * updates, prompts, document sync). Each reaches the main-owned
 * runtime through the fixed preload bridge. Unavailable outside
 * Electron.
 */
export function getExtensionDetails(identity: ExtensionIdentity): Promise<ExtensionDetails> {
  const api = getExtensionManagementApi()?.getDetails
  if (api === undefined) {
    return Promise.reject(new Error('Extension details are unavailable.'))
  }
  return api(identity)
}

export function setExtensionTrust(identity: ExtensionIdentity, trusted: boolean): Promise<boolean> {
  const api = getExtensionManagementApi()?.setTrust
  if (api === undefined) {
    return Promise.reject(new Error('Extension trust is unavailable.'))
  }
  return api(identity, trusted)
}

export function acknowledgeAndActivateExtension(identity: ExtensionIdentity): Promise<ExtensionActivationResult> {
  const api = getExtensionManagementApi()?.acknowledgeAndActivate
  if (api === undefined) {
    return Promise.reject(new Error('Extension activation is unavailable.'))
  }
  return api(identity)
}

export function fireExtensionTrigger(trigger: ExtensionTrigger): Promise<ExtensionTriggerOutcome> {
  const api = getExtensionManagementApi()?.fireTrigger
  if (api === undefined) {
    return Promise.reject(new Error('Extension triggers are unavailable.'))
  }
  return api(trigger)
}

export function listExtensionCommands(): Promise<readonly ExtensionCommand[]> {
  const api = getExtensionManagementApi()?.listCommands
  if (api === undefined) {
    return Promise.reject(new Error('Extension commands are unavailable.'))
  }
  return api()
}

export function invokeExtensionCommand(command: string, args?: readonly unknown[]): Promise<unknown> {
  const api = getExtensionManagementApi()?.invokeCommand
  if (api === undefined) {
    return Promise.reject(new Error('Extension commands are unavailable.'))
  }
  return api(command, args)
}

export function queryExtensionProviders(query: ExtensionProviderQuery): Promise<Record<string, unknown> | null> {
  const api = getExtensionManagementApi()?.queryProviders
  if (api === undefined) {
    return Promise.reject(new Error('Extension language features are unavailable.'))
  }
  return api(query)
}

export function getExtensionDiagnostics(uri?: string): Promise<readonly ExtensionDiagnostic[]> {
  const api = getExtensionManagementApi()?.getDiagnostics
  if (api === undefined) {
    return Promise.reject(new Error('Extension diagnostics are unavailable.'))
  }
  return api(uri)
}

export function getExtensionOutput(channel: string): Promise<readonly string[]> {
  const api = getExtensionManagementApi()?.getOutput
  if (api === undefined) {
    return Promise.reject(new Error('Extension output is unavailable.'))
  }
  return api(channel)
}

export function listExtensionOutputChannels(): Promise<readonly string[]> {
  const api = getExtensionManagementApi()?.listOutputChannels
  if (api === undefined) {
    return Promise.reject(new Error('Extension output is unavailable.'))
  }
  return api()
}

export function getExtensionStatusItems(): Promise<readonly ExtensionStatusItem[]> {
  const api = getExtensionManagementApi()?.getStatusItems
  if (api === undefined) {
    return Promise.reject(new Error('Extension status items are unavailable.'))
  }
  return api()
}

export function listExtensionNotifications(): Promise<readonly ExtensionNotification[]> {
  const api = getExtensionManagementApi()?.listNotifications
  if (api === undefined) {
    return Promise.reject(new Error('Extension notifications are unavailable.'))
  }
  return api()
}

export function listExtensionEditProposals(): Promise<readonly ExtensionEditProposal[]> {
  const api = getExtensionManagementApi()?.listEditProposals
  if (api === undefined) {
    return Promise.reject(new Error('Extension proposals are unavailable.'))
  }
  return api()
}

export function dismissExtensionProposal(proposalId: string): Promise<boolean> {
  const api = getExtensionManagementApi()?.dismissProposal
  if (api === undefined) {
    return Promise.reject(new Error('Extension proposals are unavailable.'))
  }
  return api(proposalId)
}

export function getExtensionConfig(extensionId: string): Promise<Record<string, string | number | boolean | null | readonly string[]>> {
  const api = getExtensionManagementApi()?.getConfig
  if (api === undefined) {
    return Promise.reject(new Error('Extension settings are unavailable.'))
  }
  return api(extensionId)
}

export function updateExtensionConfig(extensionId: string, key: string, value: string | number | boolean | null): Promise<void> {
  const api = getExtensionManagementApi()?.updateConfig
  if (api === undefined) {
    return Promise.reject(new Error('Extension settings are unavailable.'))
  }
  return api(extensionId, key, value)
}

export function checkExtensionUpdate(identity: ExtensionIdentity): Promise<ExtensionUpdateCheck> {
  const api = getExtensionManagementApi()?.checkUpdate
  if (api === undefined) {
    return Promise.reject(new Error('Extension updates are unavailable.'))
  }
  return api(identity)
}

export function getExtensionAutoUpdate(): Promise<boolean> {
  const api = getExtensionManagementApi()?.getAutoUpdate
  if (api === undefined) {
    return Promise.reject(new Error('Extension preferences are unavailable.'))
  }
  return api()
}

export function setExtensionAutoUpdate(enabled: boolean): Promise<boolean> {
  const api = getExtensionManagementApi()?.setAutoUpdate
  if (api === undefined) {
    return Promise.reject(new Error('Extension preferences are unavailable.'))
  }
  return api(enabled)
}

export function listExtensionPrompts(): Promise<readonly ExtensionPrompt[]> {
  const api = getExtensionManagementApi()?.listPrompts
  if (api === undefined) {
    return Promise.reject(new Error('Extension prompts are unavailable.'))
  }
  return api()
}

export function resolveExtensionPrompt(resolution: ExtensionPromptResolution): Promise<boolean> {
  const api = getExtensionManagementApi()?.resolvePrompt
  if (api === undefined) {
    return Promise.reject(new Error('Extension prompts are unavailable.'))
  }
  return api(resolution)
}

export function pushExtensionDocumentEvent(event: ExtensionDocumentEvent): Promise<void> {
  const api = getExtensionManagementApi()?.pushDocumentEvent
  if (api === undefined) {
    return Promise.reject(new Error('Extension document sync is unavailable.'))
  }
  return api(event)
}

export function setExtensionActiveEditor(editor: { uri: string; languageId: string } | null): Promise<void> {
  const api = getExtensionManagementApi()?.setActiveEditor
  if (api === undefined) {
    return Promise.reject(new Error('Extension document sync is unavailable.'))
  }
  return api(editor)
}

export function setExtensionWorkspaceFolders(folders: readonly { uri: string; name: string }[] | null): Promise<void> {
  const api = getExtensionManagementApi()?.setWorkspaceFolders
  if (api === undefined) {
    return Promise.reject(new Error('Extension document sync is unavailable.'))
  }
  return api(folders)
}

export function onExtensionManagementEvent(listener: (event: { kind: string; payload: Record<string, unknown> }) => void): () => void {
  const api = getExtensionManagementApi()?.onEvent
  if (api === undefined) {
    return () => {}
  }
  return api(listener)
}

export function listExtensionLanguages(): Promise<readonly ExtensionLanguage[]> {
  const api = getExtensionManagementApi()?.listLanguages
  if (api === undefined) {
    return Promise.reject(new Error('Extension languages are unavailable.'))
  }
  return api()
}

export function getExtensionSnippets(languageId?: string): Promise<readonly ExtensionSnippet[]> {
  const api = getExtensionManagementApi()?.getSnippets
  if (api === undefined) {
    return Promise.reject(new Error('Extension snippets are unavailable.'))
  }
  return api(languageId)
}

export function getExtensionThemeData(identity: ExtensionIdentity, themeId: string): Promise<ExtensionThemeData | null> {
  const api = getExtensionManagementApi()?.getThemeData
  if (api === undefined) {
    return Promise.reject(new Error('Extension themes are unavailable.'))
  }
  return api(identity, themeId)
}

export function getExtensionIconTheme(identity: ExtensionIdentity, themeId: string): Promise<ExtensionIconTheme | null> {
  const api = getExtensionManagementApi()?.getIconTheme
  if (api === undefined) {
    return Promise.reject(new Error('Extension icon themes are unavailable.'))
  }
  return api(identity, themeId)
}

export function getSelectedExtensionThemes(): Promise<{ editor: SelectedThemeRef | null; icon: SelectedThemeRef | null }> {
  const api = getExtensionManagementApi()?.getSelectedThemes
  if (api === undefined) {
    return Promise.reject(new Error('Extension themes are unavailable.'))
  }
  return api()
}

export function setSelectedExtensionTheme(kind: 'editor' | 'icon', ref: SelectedThemeRef | null): Promise<{ editor: SelectedThemeRef | null; icon: SelectedThemeRef | null }> {
  const api = getExtensionManagementApi()?.setSelectedTheme
  if (api === undefined) {
    return Promise.reject(new Error('Extension themes are unavailable.'))
  }
  return api(kind, ref)
}

export function listExtensionJsonSchemas(): Promise<readonly ExtensionJsonSchema[]> {
  const api = getExtensionManagementApi()?.listJsonSchemas
  if (api === undefined) {
    return Promise.reject(new Error('Extension JSON schemas are unavailable.'))
  }
  return api()
}
