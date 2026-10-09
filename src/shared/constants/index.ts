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
  changesRollback: 'stark:changes:rollback',
  terminalCreate: 'stark:terminal:create',
  terminalWrite: 'stark:terminal:write',
  terminalResize: 'stark:terminal:resize',
  terminalKill: 'stark:terminal:kill',
  terminalData: 'stark:terminal:data',
  terminalExit: 'stark:terminal:exit',
  gitGetStatus: 'stark:git:get-status',
  gitGetDiff: 'stark:git:get-diff',
  sessionsCreate: 'stark:sessions:create',
  sessionsList: 'stark:sessions:list',
  sessionsListMessages: 'stark:sessions:list-messages',
  sessionsSendUserMessage: 'stark:sessions:send-user-message',
  sessionContextPrepareExcerpt: 'stark:session-context:prepare-excerpt',
  sessionContextPrepareFile: 'stark:session-context:prepare-file',
  sessionContextPrepareSearchMatch: 'stark:session-context:prepare-search-match',
  sessionContextPrepareNote: 'stark:session-context:prepare-note',
  providersGetState: 'stark:providers:get-state',
  providersSaveCredential: 'stark:providers:save-credential',
  providersClearCredential: 'stark:providers:clear-credential',
  providersTestConnection: 'stark:providers:test-connection',
  providersListModels: 'stark:providers:list-models',
  providersSetModel: 'stark:providers:set-model',
  aiGenerateResponse: 'stark:ai:generate-response',
  aiProposeFileChange: 'stark:ai:propose-file-change',
  aiProposeChangeSet: 'stark:ai:propose-change-set',
  aiRunBrain: 'stark:ai:run-brain',
  changeSetsGet: 'stark:change-sets:get',
  changeSetsListRecent: 'stark:change-sets:list-recent',
  orchestrationGet: 'stark:orchestration:get',
  orchestrationListRecent: 'stark:orchestration:list-recent',
  heartGet: 'stark:heart:get',
  heartUpdate: 'stark:heart:update',
  looplinkCreateContinuation: 'stark:looplink:create-continuation',
  looplinkGetForSession: 'stark:looplink:get-for-session',
  looplinkDismiss: 'stark:looplink:dismiss',
  recoveryGetConfig: 'stark:recovery:get-config',
  recoveryUpdateConfig: 'stark:recovery:update-config',
  recoveryGetForSource: 'stark:recovery:get-for-source',
  recoveryGetForTarget: 'stark:recovery:get-for-target',
  recoveryDismiss: 'stark:recovery:dismiss',
  capabilitiesGetWorkspaceConfig: 'stark:capabilities:get-workspace-config',
  capabilitiesUpdateWorkspaceConfig: 'stark:capabilities:update-workspace-config',
  workerToolsGetPendingApproval: 'stark:worker-tools:get-pending-approval',
  workerToolsApproveAndResume: 'stark:worker-tools:approve-and-resume',
  workerToolsDenyAndResume: 'stark:worker-tools:deny-and-resume',
  runtimesGetActive: 'stark:runtimes:get-active',
  runtimesListRecent: 'stark:runtimes:list-recent',
  runtimesStop: 'stark:runtimes:stop',
  runtimesOpenPreview: 'stark:runtimes:open-preview',
  runtimesReloadPreview: 'stark:runtimes:reload-preview',
  runtimeUpdated: 'stark:runtime:updated',
  usageGetConfig: 'stark:usage:get-config',
  usageUpdateConfig: 'stark:usage:update-config',
  usageGetSummary: 'stark:usage:get-summary'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
