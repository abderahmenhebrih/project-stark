import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type { LocalProfile } from '../shared/profile/types'
import type { SettingsUpdatePatch, StarkSettings } from '../shared/settings/types'
import type { ChooseWorkspaceResult, Workspace } from '../shared/workspace/types'
import type {
  ChangeTransaction,
  ChangeTransactionRequest,
  CreateFileChangeRequest,
  ListChangeTransactionsRequest
} from '../shared/change-transactions/types'
import type {
  WorkspaceDirectoryListing,
  WorkspaceTextFile,
  WorkspaceTextFileWriteRequest,
  WorkspaceTextFileWriteResult
} from '../shared/workspace-files/types'
import type {
  WorkspaceSearchRequest,
  WorkspaceSearchResult
} from '../shared/workspace-search/types'
import type {
  CreateTerminalRequest,
  TerminalApi,
  TerminalDataEvent,
  TerminalDataListener,
  TerminalExitEvent,
  TerminalExitListener,
  TerminalKillRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalWriteRequest
} from '../shared/terminal/types'
import type { GitApi, GitDiffRequest, GitDiffResult, GitWorkspaceState } from '../shared/git/types'
import type {
  PrepareFileExcerptRequest,
  PrepareManualNoteRequest,
  PrepareSearchMatchRequest,
  PrepareWholeFileRequest,
  SessionContextApi,
  SessionContextDraft
} from '../shared/context/types'
import type {
  CodingMessagePage,
  CodingSession,
  ListSessionMessagesRequest,
  SendUserMessageRequest,
  SendUserMessageResult,
  SessionsApi
} from '../shared/sessions/types'
import type {
  AiProviderState,
  ProviderConnectionResult,
  ProviderId,
  ProviderModel,
  ProvidersApi,
  SaveProviderCredentialRequest,
  SetProviderModelRequest
} from '../shared/providers/types'
import type { AiApi, AiGenerateRequest, AiProposeFileChangeRequest, AiFileChangeProposalResult, AiProposeChangeSetRequest, AiChangeSetProposalResult, AiRunBrainRequest, AskRecoveryResult, WorkRecoveryResult } from '../shared/ai/types'
import type { ChangeSetRequest, ChangeSetsApi, ListChangeSetsRequest } from '../shared/change-sets/types'
import type { ChangeSet } from '../shared/change-sets/types'
import type {
  ListOrchestrationRunsRequest,
  OrchestrationApi,
  OrchestrationRun,
  OrchestrationRunRequest
} from '../shared/orchestration/types'
import type { HeartApi, HeartConfig, UpdateHeartConfigRequest } from '../shared/heart/types'
import type {
  CreateLooplinkRequest,
  CreateLooplinkResult,
  LooplinkApi,
  LooplinkForSessionRequest,
  LooplinkPreview
} from '../shared/looplink/types'
import type {
  RecoveryApi,
  RecoveryConfig,
  RecoveryEvent,
  RecoveryForSourceRequest,
  RecoveryForTargetRequest,
  UpdateRecoveryConfigRequest
} from '../shared/recovery/types'
import type {
  CapabilitiesApi,
  GetWorkspaceCapabilityConfigRequest,
  UpdateWorkspaceCapabilityConfigRequest,
  WorkspaceCapabilityConfig
} from '../shared/capabilities/types'
import type {
  DecideApprovalRequest,
  GetPendingApprovalRequest,
  WorkerToolApproval,
  WorkerToolsApi
} from '../shared/worker-tools/types'
import type {
  UpdateUsageConfigRequest,
  UsageApi,
  UsageConfig,
  UsageSummary
} from '../shared/usage/types'
import type {
  GetActiveRuntimeRequest,
  ListRecentRuntimesRequest,
  ProjectRuntimeSummary,
  ProjectRuntimeUpdatedEvent,
  ProjectRuntimeUpdatedListener,
  ProjectRuntimesApi,
  RuntimeRefRequest
} from '../shared/project-runtime/types'
import type {
  CloudAccountApi,
  CloudAccountStatus,
  StartSignInRequest,
  StartSignInResult
} from '../shared/cloud-account/types'
import { isCloudAccountStatus } from '../shared/cloud-account/types'
import type { AppInfo, StarkApi } from '../shared/types'

/**
 * Secure preload bridge.
 *
 * This is the ONLY code that runs with access to both the Electron API
 * and the renderer window. It exposes a minimal, typed `window.stark`
 * object of fixed per-domain functions — no `ipcRenderer`, no channel
 * choice, no `process`, no Node.js.
 */

function isTerminalDataEvent(value: unknown): value is TerminalDataEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record['sessionId'] === 'string' && typeof record['data'] === 'string'
}

function isTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  const exitCode = record['exitCode']
  const signal = record['signal']
  return (
    typeof record['sessionId'] === 'string' &&
    (exitCode === null || typeof exitCode === 'number') &&
    (signal === null || typeof signal === 'number')
  )
}

function createTerminalApi(): TerminalApi {
  return {
    create: (request: CreateTerminalRequest): Promise<TerminalSession> =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, request) as Promise<TerminalSession>,
    write: (request: TerminalWriteRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalWrite, request) as Promise<void>,
    resize: (request: TerminalResizeRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request) as Promise<void>,
    kill: (request: TerminalKillRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalKill, request) as Promise<void>,
    onData: (listener: TerminalDataListener): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        if (isTerminalDataEvent(payload)) {
          listener({ sessionId: payload.sessionId, data: payload.data })
        }
      }
      ipcRenderer.on(IPC_CHANNELS.terminalData, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalData, handler)
      }
    },
    onExit: (listener: TerminalExitListener): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        if (isTerminalExitEvent(payload)) {
          listener({ sessionId: payload.sessionId, exitCode: payload.exitCode, signal: payload.signal })
        }
      }
      ipcRenderer.on(IPC_CHANNELS.terminalExit, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalExit, handler)
      }
    }
  }
}

function createGitApi(): GitApi {
  return {
    getStatus: (workspaceId: number): Promise<GitWorkspaceState> =>
      ipcRenderer.invoke(IPC_CHANNELS.gitGetStatus, { workspaceId }) as Promise<GitWorkspaceState>,
    getDiff: (request: GitDiffRequest): Promise<GitDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.gitGetDiff, request) as Promise<GitDiffResult>
  }
}

function createSessionsApi(): SessionsApi {
  return {
    create: (workspaceId: number): Promise<CodingSession> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsCreate, { workspaceId }) as Promise<CodingSession>,
    list: (workspaceId: number): Promise<readonly CodingSession[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsList, { workspaceId }) as Promise<readonly CodingSession[]>,
    listMessages: (request: ListSessionMessagesRequest): Promise<CodingMessagePage> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsListMessages, request) as Promise<CodingMessagePage>,
    sendUserMessage: (request: SendUserMessageRequest): Promise<SendUserMessageResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsSendUserMessage, request) as Promise<SendUserMessageResult>
  }
}

function createProvidersApi(): ProvidersApi {
  return {
    getState: (providerId: ProviderId): Promise<AiProviderState> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersGetState, { providerId }) as Promise<AiProviderState>,
    saveCredential: (request: SaveProviderCredentialRequest): Promise<AiProviderState> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersSaveCredential, request) as Promise<AiProviderState>,
    clearCredential: (providerId: ProviderId): Promise<AiProviderState> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersClearCredential, { providerId }) as Promise<AiProviderState>,
    testConnection: (providerId: ProviderId): Promise<ProviderConnectionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersTestConnection, { providerId }) as Promise<ProviderConnectionResult>,
    listModels: (providerId: ProviderId): Promise<readonly ProviderModel[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersListModels, { providerId }) as Promise<readonly ProviderModel[]>,
    setModel: (request: SetProviderModelRequest): Promise<AiProviderState> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersSetModel, request) as Promise<AiProviderState>
  }
}

function createAiApi(): AiApi {
  return {
    generateResponse: (request: AiGenerateRequest): Promise<AskRecoveryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.aiGenerateResponse, request) as Promise<AskRecoveryResult>,
    proposeFileChange: (request: AiProposeFileChangeRequest): Promise<AiFileChangeProposalResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.aiProposeFileChange, request) as Promise<AiFileChangeProposalResult>,
    proposeChangeSet: (request: AiProposeChangeSetRequest): Promise<AiChangeSetProposalResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.aiProposeChangeSet, request) as Promise<AiChangeSetProposalResult>,
    runBrain: (request: AiRunBrainRequest): Promise<WorkRecoveryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.aiRunBrain, request) as Promise<WorkRecoveryResult>
  }
}

function createOrchestrationApi(): OrchestrationApi {
  return {
    get: (request: OrchestrationRunRequest): Promise<OrchestrationRun> =>
      ipcRenderer.invoke(IPC_CHANNELS.orchestrationGet, request) as Promise<OrchestrationRun>,
    listRecent: (request: ListOrchestrationRunsRequest): Promise<readonly OrchestrationRun[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.orchestrationListRecent, request) as Promise<readonly OrchestrationRun[]>
  }
}

function createHeartApi(): HeartApi {
  return {
    get: (): Promise<HeartConfig | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.heartGet) as Promise<HeartConfig | null>,
    update: (config: UpdateHeartConfigRequest): Promise<HeartConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.heartUpdate, config) as Promise<HeartConfig>
  }
}

function createLooplinkApi(): LooplinkApi {
  return {
    createContinuation: (request: CreateLooplinkRequest): Promise<CreateLooplinkResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.looplinkCreateContinuation, request) as Promise<CreateLooplinkResult>,
    getForSession: (request: LooplinkForSessionRequest): Promise<LooplinkPreview | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.looplinkGetForSession, request) as Promise<LooplinkPreview | null>,
    dismiss: (request: LooplinkForSessionRequest): Promise<LooplinkPreview> =>
      ipcRenderer.invoke(IPC_CHANNELS.looplinkDismiss, request) as Promise<LooplinkPreview>
  }
}

function createRecoveryApi(): RecoveryApi {
  return {
    getConfig: (): Promise<RecoveryConfig | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.recoveryGetConfig) as Promise<RecoveryConfig | null>,
    updateConfig: (config: UpdateRecoveryConfigRequest): Promise<RecoveryConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.recoveryUpdateConfig, config) as Promise<RecoveryConfig>,
    getForSource: (request: RecoveryForSourceRequest): Promise<RecoveryEvent | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.recoveryGetForSource, request) as Promise<RecoveryEvent | null>,
    getForTarget: (request: RecoveryForTargetRequest): Promise<RecoveryEvent | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.recoveryGetForTarget, request) as Promise<RecoveryEvent | null>,
    dismiss: (request: RecoveryForTargetRequest): Promise<RecoveryEvent> =>
      ipcRenderer.invoke(IPC_CHANNELS.recoveryDismiss, request) as Promise<RecoveryEvent>
  }
}

function createUsageApi(): UsageApi {
  return {
    getConfig: (): Promise<UsageConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.usageGetConfig) as Promise<UsageConfig>,
    updateConfig: (config: UpdateUsageConfigRequest): Promise<UsageConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.usageUpdateConfig, config) as Promise<UsageConfig>,
    getSummary: (): Promise<UsageSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.usageGetSummary) as Promise<UsageSummary>
  }
}

function createCapabilitiesApi(): CapabilitiesApi {
  return {
    getWorkspaceConfig: (request: GetWorkspaceCapabilityConfigRequest): Promise<WorkspaceCapabilityConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.capabilitiesGetWorkspaceConfig, request) as Promise<WorkspaceCapabilityConfig>,
    updateWorkspaceConfig: (config: UpdateWorkspaceCapabilityConfigRequest): Promise<WorkspaceCapabilityConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig, config) as Promise<WorkspaceCapabilityConfig>
  }
}

function isProjectRuntimeUpdatedEvent(value: unknown): value is ProjectRuntimeUpdatedEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  const runtime = record['runtime']
  return (
    typeof record['workspaceId'] === 'number' &&
    (runtime === null || (typeof runtime === 'object' && runtime !== null && typeof (runtime as Record<string, unknown>)['id'] === 'number'))
  )
}

function createWorkerToolsApi(): WorkerToolsApi {
  return {
    getPendingApproval: (request: GetPendingApprovalRequest): Promise<WorkerToolApproval | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.workerToolsGetPendingApproval, request) as Promise<WorkerToolApproval | null>,
    approveAndResume: (request: DecideApprovalRequest): Promise<WorkRecoveryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.workerToolsApproveAndResume, request) as Promise<WorkRecoveryResult>,
    denyAndResume: (request: DecideApprovalRequest): Promise<WorkRecoveryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.workerToolsDenyAndResume, request) as Promise<WorkRecoveryResult>
  }
}

function createRuntimesApi(): ProjectRuntimesApi {
  return {
    getActive: (request: GetActiveRuntimeRequest): Promise<ProjectRuntimeSummary | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimesGetActive, request) as Promise<ProjectRuntimeSummary | null>,
    listRecent: (request: ListRecentRuntimesRequest): Promise<readonly ProjectRuntimeSummary[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimesListRecent, request) as Promise<readonly ProjectRuntimeSummary[]>,
    stop: (request: RuntimeRefRequest): Promise<ProjectRuntimeSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimesStop, request) as Promise<ProjectRuntimeSummary>,
    openPreview: (request: RuntimeRefRequest): Promise<ProjectRuntimeSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimesOpenPreview, request) as Promise<ProjectRuntimeSummary>,
    reloadPreview: (request: RuntimeRefRequest): Promise<ProjectRuntimeSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimesReloadPreview, request) as Promise<ProjectRuntimeSummary>,
    onUpdated: (listener: ProjectRuntimeUpdatedListener): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        if (isProjectRuntimeUpdatedEvent(payload)) {
          listener(payload)
        }
      }
      ipcRenderer.on(IPC_CHANNELS.runtimeUpdated, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.runtimeUpdated, handler)
      }
    }
  }
}

function createChangeSetsApi(): ChangeSetsApi {
  return {
    get: (request: ChangeSetRequest): Promise<ChangeSet> =>
      ipcRenderer.invoke(IPC_CHANNELS.changeSetsGet, request) as Promise<ChangeSet>,
    listRecent: (request: ListChangeSetsRequest): Promise<readonly ChangeSet[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.changeSetsListRecent, request) as Promise<readonly ChangeSet[]>
  }
}

function createSessionContextApi(): SessionContextApi {
  return {
    prepareExcerpt: (request: PrepareFileExcerptRequest): Promise<SessionContextDraft> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionContextPrepareExcerpt, request) as Promise<SessionContextDraft>,
    prepareFile: (request: PrepareWholeFileRequest): Promise<SessionContextDraft> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionContextPrepareFile, request) as Promise<SessionContextDraft>,
    prepareSearchMatch: (request: PrepareSearchMatchRequest): Promise<SessionContextDraft> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionContextPrepareSearchMatch, request) as Promise<SessionContextDraft>,
    prepareNote: (request: PrepareManualNoteRequest): Promise<SessionContextDraft> =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionContextPrepareNote, request) as Promise<SessionContextDraft>
  }
}

function createAccountApi(): CloudAccountApi {
  return {
    getStatus: (): Promise<CloudAccountStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.accountGetStatus, {}) as Promise<CloudAccountStatus>,
    startSignIn: (request: StartSignInRequest): Promise<StartSignInResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.accountStartSignIn, request) as Promise<StartSignInResult>,
    cancelSignIn: (): Promise<CloudAccountStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.accountCancelSignIn, {}) as Promise<CloudAccountStatus>,
    signOut: (): Promise<CloudAccountStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.accountSignOut, {}) as Promise<CloudAccountStatus>,
    onUpdated: (listener: (status: CloudAccountStatus) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        if (isCloudAccountStatus(payload)) {
          listener(payload)
        }
      }
      ipcRenderer.on(IPC_CHANNELS.accountUpdated, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.accountUpdated, handler)
      }
    }
  }
}

const starkApi: StarkApi = {
  getAppInfo: (): Promise<AppInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>,
  settings: {
    get: (): Promise<StarkSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsGet) as Promise<StarkSettings>,
    update: (patch: SettingsUpdatePatch): Promise<StarkSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch) as Promise<StarkSettings>,
    reset: (): Promise<StarkSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsReset) as Promise<StarkSettings>
  },
  profile: {
    get: (): Promise<LocalProfile | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.profileGet) as Promise<LocalProfile | null>,
    setDisplayName: (displayName: string): Promise<LocalProfile> =>
      ipcRenderer.invoke(IPC_CHANNELS.profileSetDisplayName, displayName) as Promise<LocalProfile>
  },
  workspace: {
    getCurrent: (): Promise<Workspace | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceGetCurrent) as Promise<Workspace | null>,
    listRecent: (): Promise<Workspace[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceListRecent) as Promise<Workspace[]>,
    chooseDirectory: (): Promise<ChooseWorkspaceResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceChooseDirectory) as Promise<ChooseWorkspaceResult>,
    open: (workspaceId: number): Promise<Workspace> =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceOpen, workspaceId) as Promise<Workspace>,
    files: {
      listDirectory: (workspaceId: number, relativePath: string): Promise<WorkspaceDirectoryListing> =>
        ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesListDirectory, {
          workspaceId,
          relativePath
        }) as Promise<WorkspaceDirectoryListing>,
      readTextFile: (workspaceId: number, relativePath: string): Promise<WorkspaceTextFile> =>
        ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesReadTextFile, {
          workspaceId,
          relativePath
        }) as Promise<WorkspaceTextFile>,
      writeTextFile: (request: WorkspaceTextFileWriteRequest): Promise<WorkspaceTextFileWriteResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesWriteTextFile, request) as Promise<WorkspaceTextFileWriteResult>
    },
    search: (request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceSearch, request) as Promise<WorkspaceSearchResult>,
    changes: {
      create: (request: CreateFileChangeRequest): Promise<ChangeTransaction> =>
        ipcRenderer.invoke(IPC_CHANNELS.changesCreate, request) as Promise<ChangeTransaction>,
      get: (request: ChangeTransactionRequest): Promise<ChangeTransaction> =>
        ipcRenderer.invoke(IPC_CHANNELS.changesGet, request) as Promise<ChangeTransaction>,
      listRecent: (request: ListChangeTransactionsRequest): Promise<readonly ChangeTransaction[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.changesListRecent, request) as Promise<readonly ChangeTransaction[]>,
      accept: (request: ChangeTransactionRequest): Promise<ChangeTransaction> =>
        ipcRenderer.invoke(IPC_CHANNELS.changesAccept, request) as Promise<ChangeTransaction>,
      reject: (request: ChangeTransactionRequest): Promise<ChangeTransaction> =>
        ipcRenderer.invoke(IPC_CHANNELS.changesReject, request) as Promise<ChangeTransaction>,
      rollback: (request: ChangeTransactionRequest): Promise<ChangeTransaction> =>
        ipcRenderer.invoke(IPC_CHANNELS.changesRollback, request) as Promise<ChangeTransaction>
    }
  },
  terminal: createTerminalApi(),
  git: createGitApi(),
  sessions: createSessionsApi(),
  sessionContext: createSessionContextApi(),
  providers: createProvidersApi(),
  ai: createAiApi(),
  changeSets: createChangeSetsApi(),
  orchestration: createOrchestrationApi(),
  heart: createHeartApi(),
  looplink: createLooplinkApi(),
  recovery: createRecoveryApi(),
  capabilities: createCapabilitiesApi(),
  workerTools: createWorkerToolsApi(),
  runtimes: createRuntimesApi(),
  usage: createUsageApi(),
  account: createAccountApi()
}

contextBridge.exposeInMainWorld('stark', starkApi)
