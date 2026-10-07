import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { APP_NAME, IPC_CHANNELS, type IpcChannel } from '../../shared/constants'
import { RENDERER_DEV_URL, RENDERER_ENTRY } from '../security/app-urls'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { SettingsService } from '../settings/settings-service'
import type { ProfileService } from '../profile/profile-service'
import type { WorkspaceService } from '../workspace/workspace-service'
import type { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { getAppInfo } from '../services/app-info'
import type { IpcBinding } from './binding'
import { createChangeTransactionBindings } from './change-transactions'
import { createProfileBindings } from './profile'
import { createSettingsBindings } from './settings'
import { isTrustedIpcSender } from './trust'
import { createWorkspaceBindings, electronDirectoryPicker } from './workspace'
import { createWorkspaceFilesBindings } from './workspace-files'
import { createWorkspaceSearchBindings } from './workspace-search'

/**
 * Registers an IPC handler that first proves the caller is STARK's own
 * renderer (dev-server origin in development, packaged document in
 * production). Untrusted callers are rejected with an error, which
 * surfaces to the renderer as a rejected invoke promise.
 *
 * Every privileged handler must use this instead of ipcMain.handle.
 */
export function handleSecureIpc<TArgs extends unknown[], TReturn>(
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TReturn | Promise<TReturn>
): void {
  ipcMain.handle(channel, (event, ...args: TArgs) => {
    const trusted = isTrustedIpcSender(
      event.sender.isDestroyed(),
      event.senderFrame?.url ?? event.sender.getURL(),
      { devServerUrl: RENDERER_DEV_URL, rendererEntryFile: RENDERER_ENTRY }
    )
    if (!trusted) {
      console.warn(`[${APP_NAME}] rejected IPC '${channel}' from an untrusted sender`)
      throw new Error(`[stark] untrusted IPC sender for '${channel}'`)
    }
    return handler(event, ...args)
  })
}

/** Dependencies handed to every database-backed IPC handler. */
export interface IpcDependencies {
  readonly settingsService: SettingsService
  readonly profileService: ProfileService
  readonly workspaceService: WorkspaceService
  readonly workspaceFilesService: WorkspaceFilesService
  readonly workspaceFileWriteService: WorkspaceFileWriteService
  readonly workspaceSearchService: WorkspaceSearchService
  readonly changeTransactionService: ChangeTransactionService
}

/**
 * The complete, enumerable IPC surface. Pure data — no Electron calls —
 * so tests can assert exactly which channels exist. Registration below
 * is the only place ipcMain.handle is reachable.
 */
export function createIpcBindings(deps: IpcDependencies): readonly IpcBinding[] {
  return [
    ...createSettingsBindings(deps.settingsService),
    ...createProfileBindings(deps.profileService),
    ...createWorkspaceBindings(deps.workspaceService, electronDirectoryPicker),
    ...createWorkspaceFilesBindings(deps.workspaceFilesService, deps.workspaceFileWriteService),
    ...createWorkspaceSearchBindings(deps.workspaceSearchService),
    ...createChangeTransactionBindings(deps.changeTransactionService)
  ]
}

/**
 * Registers every IPC handler exposed to renderers.
 *
 * Rules for this module:
 * - One handler per channel declared in shared/constants IPC_CHANNELS.
 * - Handlers delegate to services; no business logic lives here.
 * - Never expose filesystem, shell, or process spawning to the renderer.
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  handleSecureIpc(IPC_CHANNELS.getAppInfo, () => getAppInfo())
  for (const binding of createIpcBindings(deps)) {
    handleSecureIpc(binding.channel, (event, payload: unknown) => binding.invoke(payload, event))
  }
}
