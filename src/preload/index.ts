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
import type { AiApi, AiGenerateRequest, AiGenerateResult } from '../shared/ai/types'
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
    generateResponse: (request: AiGenerateRequest): Promise<AiGenerateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.aiGenerateResponse, request) as Promise<AiGenerateResult>
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
  providers: createProvidersApi(),
  ai: createAiApi()
}

contextBridge.exposeInMainWorld('stark', starkApi)
