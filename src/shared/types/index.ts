/**
 * Shared types used by the Electron main process, the preload bridge,
 * and the React renderer.
 *
 * Everything in this layer must be plain TypeScript — no Node.js APIs,
 * no DOM APIs — so it stays importable from every process.
 */

/** Read-only application metadata served by the main process over IPC. */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
  readonly electron: string
  readonly chrome: string
  readonly node: string
}

/**
 * The only API surface exposed to the renderer.
 * Raw Node.js / Electron APIs are never exposed directly.
 */
export interface StarkApi {
  getAppInfo: () => Promise<AppInfo>
}

/** Lifecycle status shown by the development shell. */
export type SystemStatus = 'ready' | 'starting' | 'error'
