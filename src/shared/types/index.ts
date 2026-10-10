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
import type { CloudAccountApi } from '../cloud-account/types'
import type { SessionsApi } from '../sessions/types'
import type { SessionContextApi } from '../context/types'
import type { ProvidersApi } from '../providers/types'
import type { AiApi } from '../ai/types'
import type { ChangeSetsApi } from '../change-sets/types'
import type { HeartApi } from '../heart/types'
import type { LooplinkApi } from '../looplink/types'
import type { RecoveryApi } from '../recovery/types'
import type { CapabilitiesApi } from '../capabilities/types'
import type { UsageApi } from '../usage/types'
import type { ProjectRuntimesApi } from '../project-runtime/types'
import type { WorkerToolsApi } from '../worker-tools/types'
import type { OrchestrationApi } from '../orchestration/types'
import type { SettingsApi } from '../settings/types'
import type { TerminalApi } from '../terminal/types'
import type { GitApi } from '../git/types'
import type { ExtensionsApi } from '../extension-registry/types'
import type { ExtensionActivationApi, ExtensionHostApi } from '../extension-host/types'
import type { ExtensionManagementApi } from '../extension-management/types'
import type { FormatterApi } from '../formatter/types'
import type { ChatAttachmentsApi } from '../chat-attachments/types'
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
  sessionContext: SessionContextApi
  providers: ProvidersApi
  ai: AiApi
  changeSets: ChangeSetsApi
  orchestration: OrchestrationApi
  heart: HeartApi
  looplink: LooplinkApi
  recovery: RecoveryApi
  capabilities: CapabilitiesApi
  workerTools: WorkerToolsApi
  runtimes: ProjectRuntimesApi
  usage: UsageApi
  account: CloudAccountApi
  extensions: ExtensionsApi
  extensionHost: ExtensionHostApi
  extensionActivation: ExtensionActivationApi
  extensionManagement: ExtensionManagementApi
  formatter: FormatterApi
  attachments: ChatAttachmentsApi
}

/** Lifecycle status shown by the development shell. */
export type SystemStatus = 'ready' | 'starting' | 'error'
