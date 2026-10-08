import { IPC_CHANNELS } from '../../shared/constants'
import type { CreateLooplinkResult, LooplinkPreview } from '../../shared/looplink/types'
import type { LooplinkService } from '../looplink/looplink-service'
import { toPublicLooplinkError } from '../looplink/looplink-errors'
import type { IpcBinding } from './binding'

/**
 * Looplink IPC bindings (Stage 20): exactly three channels — explicit
 * continuation, pending lookup, and dismissal. The renderer submits
 * workspace/session references only; payloads, hashes, and target
 * sessions all derive main-side. No message is sent and no provider
 * is called by any of these operations. Registration through
 * handleSecureIpc happens in ./index.ts.
 */
export function createLooplinkBindings(service: LooplinkService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.looplinkCreateContinuation,
      invoke: (payload): Promise<CreateLooplinkResult> =>
        Promise.resolve()
          .then(() => service.createContinuation(payload))
          .catch((error: unknown) => {
            throw toPublicLooplinkError('create', error)
          })
    },
    {
      channel: IPC_CHANNELS.looplinkGetForSession,
      invoke: (payload): Promise<LooplinkPreview | null> =>
        Promise.resolve()
          .then(() => service.getForSession(payload))
          .catch((error: unknown) => {
            throw toPublicLooplinkError('get', error)
          })
    },
    {
      channel: IPC_CHANNELS.looplinkDismiss,
      invoke: (payload): Promise<LooplinkPreview> =>
        Promise.resolve()
          .then(() => service.dismissForSession(payload))
          .catch((error: unknown) => {
            throw toPublicLooplinkError('dismiss', error)
          })
    }
  ]
}
