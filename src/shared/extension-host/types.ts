/**
 * Shared extension-host domain contracts (generic activation core).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * The renderer supplies installed identities only (never filesystem
 * paths): main verifies installed + enabled + manifest + entrypoint,
 * then activates demand-driven inside the isolated host. The renderer
 * learns status text and active ids only — never PIDs, handles,
 * pipes, or paths. Enabled means "allowed to activate", never
 * "running": activation stays demand-driven (no startup sweep).
 */

/** Extension Host lifecycle states, main-owned. */
export type ExtensionHostState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed'

/** Renderer-safe host status. No process details cross IPC. */
export interface ExtensionHostStatus {
  readonly state: ExtensionHostState
}

/** Renderer-facing host controls (see StarkApi in shared/types). */
export interface ExtensionHostApi {
  hostStatus: () => Promise<ExtensionHostStatus>
  startHost: () => Promise<ExtensionHostStatus>
  stopHost: () => Promise<ExtensionHostStatus>
}

/** Narrow generic activation identity (never a path). */
export interface ExtensionActivationIdentity {
  readonly namespace: string
  readonly name: string
  readonly version: string
}

/** Generic activation outcome (renderer-safe, no paths). */
export interface ExtensionActivationResult {
  readonly extensionId: string
  readonly displayName: string
}

/** Generic deactivation outcome (renderer-safe). */
export interface ExtensionDeactivationResult {
  readonly extensionId: string
  readonly deactivated: boolean
}

/** Renderer-facing generic activation controls. */
export interface ExtensionActivationApi {
  activate: (identity: ExtensionActivationIdentity) => Promise<ExtensionActivationResult>
  deactivate: (identity: ExtensionActivationIdentity) => Promise<ExtensionDeactivationResult>
  listActive: () => Promise<readonly string[]>
}
