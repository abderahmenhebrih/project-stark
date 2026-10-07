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

import type { ProfileApi } from '../profile/types'
import type { SessionsApi } from '../sessions/types'
import type { ProvidersApi } from '../providers/types'
import type { AiApi } from '../ai/types'
import type { SettingsApi } from '../settings/types'
import type { TerminalApi } from '../terminal/types'
import type { GitApi } from '../git/types'
import type { WorkspaceApi } from '../workspace/types'

/**
 * The only API surface exposed to the renderer.
 * Raw Node.js / Electron APIs are never exposed directly.
 *
 * Namespaced per domain (app, settings, profile, …) so new domains do
 * not grow a flat grab-bag. The app-info entry keeps its historical
 * flat shape to avoid churning the working shell; new domains use
 * namespaces.
 */
export interface StarkApi {
  getAppInfo: () => Promise<AppInfo>
  settings: SettingsApi
  profile: ProfileApi
  workspace: WorkspaceApi
  terminal: TerminalApi
  git: GitApi
  sessions: SessionsApi
  providers: ProvidersApi
  ai: AiApi
}

/** Lifecycle status shown by the development shell. */
export type SystemStatus = 'ready' | 'starting' | 'error'
