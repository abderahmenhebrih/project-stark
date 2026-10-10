import { IPC_CHANNELS } from '../../shared/constants'
import type {
  CodingMessagePage,
  CodingSession,
  SendUserMessageResult
} from '../../shared/sessions/types'
import type { CodingSessionService } from '../sessions/coding-session-service'
import { ChatAttachmentError, toPublicAttachmentError } from '../chat-attachments/errors'
import { SessionContextError, toPublicContextError } from '../session-context/errors'
import { toPublicSessionError } from '../sessions/errors'
import type { IpcBinding } from './binding'

/**
 * Coding-session IPC bindings (Stage 13): exactly four invoke channels
 * (create, list, list-messages, send-user-message). No SQL, no
 * arbitrary-role inserts, no assistant writes, no chat:run or
 * model:complete, no generic storage. Payloads are opaque to this layer — the service
 * validates workspace/session IDs, pages, content, and attachment IDs
 * at runtime. Registration through handleSecureIpc happens in ./index.ts.
 */
export function createSessionBindings(service: CodingSessionService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.sessionsCreate,
      invoke: (payload): Promise<CodingSession> =>
        service.createSession(payload).catch((error: unknown) => {
          throw toPublicSessionError('create', error)
        })
    },
    {
      channel: IPC_CHANNELS.sessionsList,
      invoke: (payload): Promise<readonly CodingSession[]> =>
        service.listSessions(payload).catch((error: unknown) => {
          throw toPublicSessionError('list', error)
        })
    },
    {
      channel: IPC_CHANNELS.sessionsListMessages,
      invoke: (payload): Promise<CodingMessagePage> =>
        service.listMessages(payload).catch((error: unknown) => {
          throw toPublicSessionError('list-messages', error)
        })
    },
    {
      channel: IPC_CHANNELS.sessionsSendUserMessage,
      invoke: (payload): Promise<SendUserMessageResult> =>
        service.sendUserMessage(payload).catch((error: unknown) => {
          // Context attachment failures carry their own safe copy.
          if (error instanceof SessionContextError) {
            throw toPublicContextError('send', error)
          }
          // Chat-attachment failures carry their own safe copy.
          if (error instanceof ChatAttachmentError) {
            throw toPublicAttachmentError('send', error)
          }
          throw toPublicSessionError('send', error)
        })
    }
  ]
}
