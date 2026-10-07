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
import type { AppInfo, StarkApi } from '../shared/types'

/**
 * Secure preload bridge.
 *
 * This is the ONLY code that runs with access to both the Electron API
 * and the renderer window. It exposes a minimal, typed `window.stark`
 * object of fixed per-domain functions — no `ipcRenderer`, no channel
 * choice, no `process`, no Node.js.
 */
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
  }
}

contextBridge.exposeInMainWorld('stark', starkApi)
