import { IPC_CHANNELS } from '../../shared/constants'
import type { SessionContextDraft } from '../../shared/context/types'
import type { SessionContextService } from '../session-context/session-context-service'
import { toPublicContextError } from '../session-context/errors'
import type { IpcBinding } from './binding'

/**
 * Explicit project-context IPC bindings (Stage 15): exactly four
 * prepare channels (excerpt, whole file, search match, manual note).
 * Sending travels through the existing sessions send channel with
 * draft descriptors that main re-resolves from disk. Payloads are
 * opaque to this layer — the service validates workspace IDs, paths,
 * ranges, labels, and content at runtime. Registration through
 * handleSecureIpc happens in ./index.ts. No filesystem, model, or
 * generation choices cross these channels.
 */
export function createSessionContextBindings(service: SessionContextService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.sessionContextPrepareExcerpt,
      invoke: (payload): Promise<SessionContextDraft> =>
        service.prepareExcerpt(payload).catch((error: unknown) => {
          throw toPublicContextError('prepare', error)
        })
    },
    {
      channel: IPC_CHANNELS.sessionContextPrepareFile,
      invoke: (payload): Promise<SessionContextDraft> =>
        service.prepareWholeFile(payload).catch((error: unknown) => {
          throw toPublicContextError('prepare', error)
        })
    },
    {
      channel: IPC_CHANNELS.sessionContextPrepareSearchMatch,
      invoke: (payload): Promise<SessionContextDraft> =>
        service.prepareSearchMatch(payload).catch((error: unknown) => {
          throw toPublicContextError('prepare', error)
        })
    },
    {
      channel: IPC_CHANNELS.sessionContextPrepareNote,
      invoke: (payload): Promise<SessionContextDraft> =>
        service.prepareNote(payload).catch((error: unknown) => {
          throw toPublicContextError('prepare', error)
        })
    }
  ]
}
