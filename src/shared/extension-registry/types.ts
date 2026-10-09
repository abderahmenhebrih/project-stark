/**
 * Shared extension-catalog domain contracts (catalog display only).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * The renderer receives NORMALIZED metadata only: the main-owned
 * registry service calls Open VSX, validates/coerces every field, and
 * drops everything else (download URLs, signatures, raw payloads).
 * No install/update/uninstall surface exists in this step.
 */

/** One normalized catalog entry. Icon is a validated HTTPS URL or null. */
export interface ExtensionEntry {
  readonly id: string
  readonly namespace: string
  readonly name: string
  readonly displayName: string
  readonly publisher: string
  readonly description: string
  readonly version: string
  readonly downloadCount: number
  readonly rating: number | null
  readonly iconUrl: string | null
  readonly verified: boolean
}

/** Narrow search request: caller-supplied text only, never a URL. */
export interface ExtensionSearchRequest {
  readonly query: string
}

/** Bounded normalized result: at most 20 entries, never raw payloads. */
export interface ExtensionSearchResult {
  readonly entries: readonly ExtensionEntry[]
  readonly truncated: boolean
}

/** Narrow install identity: normalized registry coordinates only, never a URL or path. */
export interface ExtensionInstallIdentity {
  readonly namespace: string
  readonly name: string
  readonly version: string
}

/** Install outcome: stored locally and inert (never activated). */
export type ExtensionInstallStatus = 'installed' | 'already_installed'

/** Normalized installed metadata. No absolute paths, no code, no raw manifest. */
export interface InstalledExtensionEntry {
  readonly namespace: string
  readonly name: string
  readonly displayName: string
  readonly version: string
  readonly status: ExtensionInstallStatus
}

/** Uninstall outcome: removed locally, or refused while installing. */
export type ExtensionUninstallStatus = 'uninstalled' | 'install_in_progress'

/** Normalized uninstall result. No paths, no filesystem details. */
export interface UninstalledExtensionEntry {
  readonly namespace: string
  readonly name: string
  readonly version: string
  readonly status: ExtensionUninstallStatus
}

/** Renderer-facing extension-catalog bridge (see StarkApi in shared/types). */
export interface ExtensionsApi {
  search: (request: ExtensionSearchRequest) => Promise<ExtensionSearchResult>
  listFeatured: () => Promise<ExtensionSearchResult>
  install: (identity: ExtensionInstallIdentity) => Promise<InstalledExtensionEntry>
  listInstalled: () => Promise<readonly InstalledExtensionEntry[]>
  uninstall: (identity: ExtensionInstallIdentity) => Promise<UninstalledExtensionEntry>
}
