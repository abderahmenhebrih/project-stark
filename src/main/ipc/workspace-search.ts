import { IPC_CHANNELS } from '../../shared/constants'
import type { WorkspaceSearchResult } from '../../shared/workspace-search/types'
import { toPublicError, type WorkspaceOperation } from '../workspace/errors'
import type { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import type { IpcBinding } from './binding'

async function withPublicError<T>(operation: WorkspaceOperation, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicError(operation, error)
  }
}

/**
 * Workspace-search IPC binding: exactly one search operation.
 *
 * Payloads are opaque to this layer — the service validates workspace ids,
 * queries, and options at runtime. Registration through handleSecureIpc
 * happens in ./index.ts; no generic filesystem, grep, ripgrep, shell, or
 * absolute-path channels exist.
 */
export function createWorkspaceSearchBindings(service: WorkspaceSearchService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.workspaceSearch,
      invoke: (payload): Promise<WorkspaceSearchResult> =>
        withPublicError('search', () => service.search(payload))
    }
  ]
}
