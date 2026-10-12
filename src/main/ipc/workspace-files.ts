import { IPC_CHANNELS } from '../../shared/constants'
import type {
  WorkspaceCrudResult,
  WorkspaceDirectoryListing,
  WorkspaceTextFile,
  WorkspaceTextFileWriteResult
} from '../../shared/workspace-files/types'
import { toPublicError, type WorkspaceOperation } from '../workspace/errors'
import type { WorkspaceCrudService } from '../workspace-files/workspace-crud-service'
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
 * Workspace-files IPC bindings: list-directory, read-text-file, the
 * single stale-safe write-text-file channel, and four direct human
 * file-operation channels (create file/folder, leaf-name change, move
 * to Trash). Payloads are opaque to this layer — services validate
 * workspace ids, relative paths, and leaf names at runtime.
 * Registration through handleSecureIpc happens in ./index.ts; no
 * generic filesystem, dialog, save-as, or SQL channels exist. The
 * CRUD service is optional so older harnesses keep compiling; absent
 * means no CRUD channels. Human CRUD never creates AI transactions.
 */
export function createWorkspaceFilesBindings(
  service: WorkspaceFilesService,
  writeService: WorkspaceFileWriteService,
  crudService?: WorkspaceCrudService
): readonly IpcBinding[] {
  const bindings: IpcBinding[] = [
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
  if (crudService !== undefined) {
    bindings.push(
      {
        channel: IPC_CHANNELS.workspaceFilesCreateTextFile,
        invoke: (payload): Promise<WorkspaceCrudResult> =>
          withPublicError('create-text-file', () => crudService.createTextFile(payload))
      },
      {
        channel: IPC_CHANNELS.workspaceFilesCreateDirectory,
        invoke: (payload): Promise<WorkspaceCrudResult> =>
          withPublicError('create-directory', () => crudService.createDirectory(payload))
      },
      {
        channel: IPC_CHANNELS.workspaceFilesSetEntryName,
        invoke: (payload): Promise<WorkspaceCrudResult> =>
          withPublicError('set-entry-name', () => crudService.setEntryName(payload))
      },
      {
        channel: IPC_CHANNELS.workspaceFilesMoveToTrash,
        invoke: (payload): Promise<WorkspaceCrudResult> =>
          withPublicError('move-to-trash', () => crudService.moveToTrash(payload))
      }
    )
  }
  return bindings
}
