import { IPC_CHANNELS } from '../../shared/constants'
import type { ChangeTransaction } from '../../shared/change-transactions/types'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { toPublicChangeError } from '../change-transactions/errors'
import type { IpcBinding } from './binding'

async function withPublicChangeError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicChangeError(error)
  }
}

/**
 * Change-transaction IPC bindings: the six explicit operations
 * (create, get, list-recent, accept, reject, rollback). Payloads are
 * opaque to this layer — the service validates workspace ids,
 * transaction ids, revisions, paths, and content at runtime.
 * Registration through handleSecureIpc happens in ./index.ts; no
 * generic transaction, database, SQL, or filesystem channels exist.
 */
export function createChangeTransactionBindings(service: ChangeTransactionService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.changesCreate,
      invoke: (payload): Promise<ChangeTransaction> =>
        withPublicChangeError(() => service.createFileChange(payload))
    },
    {
      channel: IPC_CHANNELS.changesGet,
      invoke: (payload): Promise<ChangeTransaction> =>
        withPublicChangeError(() => service.getTransaction(payload))
    },
    {
      channel: IPC_CHANNELS.changesListRecent,
      invoke: (payload): Promise<readonly ChangeTransaction[]> =>
        withPublicChangeError(() => service.listRecentTransactions(payload))
    },
    {
      channel: IPC_CHANNELS.changesAccept,
      invoke: (payload): Promise<ChangeTransaction> =>
        withPublicChangeError(() => service.acceptTransaction(payload))
    },
    {
      channel: IPC_CHANNELS.changesReject,
      invoke: (payload): Promise<ChangeTransaction> =>
        withPublicChangeError(() => service.rejectTransaction(payload))
    },
    {
      channel: IPC_CHANNELS.changesRollback,
      invoke: (payload): Promise<ChangeTransaction> =>
        withPublicChangeError(() => service.rollbackTransaction(payload))
    }
  ]
}
