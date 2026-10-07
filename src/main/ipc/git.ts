import { IPC_CHANNELS } from '../../shared/constants'
import type { GitDiffResult, GitWorkspaceState } from '../../shared/git/types'
import { toPublicGitError } from '../git/errors'
import type { GitService } from '../git/git-service'
import type { IpcBinding } from './binding'

/**
 * Git IPC bindings (Stage 12, read-only): exactly two invoke channels
 * (get-status, get-diff). No git:run/exec/command, no stage/commit/
 * checkout/push/pull/fetch, no spawn/exec/shell. Payloads are opaque
 * to this layer — the service validates workspace ids, paths, and
 * targets at runtime. Registration through handleSecureIpc happens in
 * ./index.ts. get-status returns safe states (unavailable, not-repo,
 * root-mismatch, ready); only genuine operation failures throw mapped
 * public copy.
 */
export function createGitBindings(service: GitService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.gitGetStatus,
      invoke: (payload): Promise<GitWorkspaceState> =>
        service.getStatus(payload).catch((error: unknown) => {
          throw toPublicGitError('status', error)
        })
    },
    {
      channel: IPC_CHANNELS.gitGetDiff,
      invoke: (payload): Promise<GitDiffResult> =>
        service.getDiff(payload).catch((error: unknown) => {
          throw toPublicGitError('diff', error)
        })
    }
  ]
}
