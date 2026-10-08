import { IPC_CHANNELS } from '../../shared/constants'
import type { ChangeSet } from '../../shared/change-sets/types'
import type { ChangeSetService } from '../change-sets/change-set-service'
import { toPublicChangeSetError } from '../change-sets/errors'
import type { IpcBinding } from './binding'

/**
 * Change-set IPC bindings (Stage 17): exactly two narrow read
 * operations (get, list-recent). No mutation operation exists — child
 * transaction transitions continue through the existing Changes API.
 * Payloads are opaque to this layer. Registration through
 * handleSecureIpc happens in ./index.ts.
 */
export function createChangeSetBindings(service: ChangeSetService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.changeSetsGet,
      invoke: (payload): Promise<ChangeSet> =>
        service.getChangeSet(payload).catch((error: unknown) => {
          throw toPublicChangeSetError('get', error)
        })
    },
    {
      channel: IPC_CHANNELS.changeSetsListRecent,
      invoke: (payload): Promise<readonly ChangeSet[]> =>
        service.listRecentChangeSets(payload).catch((error: unknown) => {
          throw toPublicChangeSetError('list-recent', error)
        })
    }
  ]
}
