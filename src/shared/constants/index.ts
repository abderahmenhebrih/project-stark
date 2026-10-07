/**
 * Shared constants used by the Electron main process, the preload
 * bridge, and the React renderer. Keep this file free of side effects.
 */

/** Official product name. Rendered as text until the final logo asset lands. */
export const APP_NAME = 'STARK' as const

/** Official product tagline. */
export const APP_TAGLINE = 'Your model stopped. Your work didn’t.' as const

/** Status label shown by the initial development shell. */
export const SYSTEM_READY_LABEL = 'System ready' as const

/** Build-stage label shown in the shell footer. */
export const FOUNDATION_LABEL = 'Foundation build' as const

/**
 * IPC channel names. Renderers may only invoke channels listed here,
 * and each channel has exactly one handler in src/main/ipc.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'stark:get-app-info',
  settingsGet: 'stark:settings:get',
  settingsUpdate: 'stark:settings:update',
  settingsReset: 'stark:settings:reset',
  profileGet: 'stark:profile:get',
  profileSetDisplayName: 'stark:profile:set-display-name',
  workspaceGetCurrent: 'stark:workspace:get-current',
  workspaceListRecent: 'stark:workspace:list-recent',
  workspaceChooseDirectory: 'stark:workspace:choose-directory',
  workspaceOpen: 'stark:workspace:open',
  workspaceFilesListDirectory: 'stark:workspace-files:list-directory',
  workspaceFilesReadTextFile: 'stark:workspace-files:read-text-file',
  workspaceFilesWriteTextFile: 'stark:workspace-files:write-text-file',
  workspaceSearch: 'stark:workspace-search:search',
  changesCreate: 'stark:changes:create',
  changesGet: 'stark:changes:get',
  changesListRecent: 'stark:changes:list-recent',
  changesAccept: 'stark:changes:accept',
  changesReject: 'stark:changes:reject',
  changesRollback: 'stark:changes:rollback'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
