import { IPC_CHANNELS } from '../../shared/constants'
import type {
  WorkspaceDirectoryListing,
  WorkspaceTextFile,
  WorkspaceTextFileWriteResult
} from '../../shared/workspace-files/types'
import { toPublicError, type WorkspaceOperation } from '../workspace/errors'
import type { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { IpcBinding } from './binding'

async function withPublicError<T>(operation: WorkspaceOperation, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicError(operation, error)
  }
}

/**
 * Workspace-files IPC bindings: list-directory, read-text-file, and
 * the single stale-safe write-text-file channel. Payloads are opaque to
 * this layer — services validate workspace ids, relative paths,
 * revisions, and content at runtime. Registration through
 * handleSecureIpc happens in ./index.ts; no generic filesystem,
 * dialog, save-as, or SQL channels exist.
 */
export function createWorkspaceFilesBindings(
  service: WorkspaceFilesService,
  writeService: WorkspaceFileWriteService
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.workspaceFilesListDirectory,
      invoke: (payload): Promise<WorkspaceDirectoryListing> =>
        withPublicError('list-directory', () => service.listDirectory(payload))
    },
    {
      channel: IPC_CHANNELS.workspaceFilesReadTextFile,
      invoke: (payload): Promise<WorkspaceTextFile> =>
        withPublicError('read-text-file', () => service.readTextFile(payload))
    },
    {
      channel: IPC_CHANNELS.workspaceFilesWriteTextFile,
      invoke: (payload): Promise<WorkspaceTextFileWriteResult> =>
        withPublicError('write-text-file', () => writeService.writeTextFile(payload))
    }
  ]
}
