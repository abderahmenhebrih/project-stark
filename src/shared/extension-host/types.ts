/**
 * Shared extension-host domain contracts (foundation only).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * The host runs zero third-party code in this stage: it reports
 * lifecycle (ready/stopped/crashed) and answers control messages.
 * The renderer learns status text only — never PIDs, handles, pipes,
 * or filesystem paths.
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
