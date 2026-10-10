import { BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ChatAttachment } from '../../shared/chat-attachments/types'
import { toPublicAttachmentError } from '../chat-attachments/errors'
import type { AttachmentPicker } from '../chat-attachments/picker'
import type { ChatAttachmentService } from '../chat-attachments/service'
import type { IpcBinding } from './binding'

function readWorkspaceId(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw toPublicAttachmentError('choose', new Error('bad payload'))
  }
  const keys = Object.keys(payload)
  if (keys.length !== 1 || keys[0] !== 'workspaceId') {
    throw toPublicAttachmentError('choose', new Error('bad payload'))
  }
  return (payload as Record<string, unknown>)['workspaceId'] as number
}

/**
 * Chat-attachment IPC bindings: exactly two invoke channels (choose,
 * remove-draft). The picker opens as the validated sender's window;
 * picked paths flow into the service for validation. No generic
 * readFile/copyFile/path-picker/filesystem-write surface.
 * Registration through handleSecureIpc happens in ./index.ts.
 */
export function createAttachmentBindings(
  service: ChatAttachmentService,
  picker: AttachmentPicker
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.attachmentsChoose,
      invoke: (payload, event?: IpcMainInvokeEvent): Promise<readonly ChatAttachment[]> =>
        Promise.resolve()
          .then(() => readWorkspaceId(payload))
          .then(async (workspaceId) => {
            const parent =
              event === undefined ? undefined : (BrowserWindow.fromWebContents(event.sender) ?? undefined)
            const picked = await picker.pickFiles(parent)
            if (picked === undefined) {
              return []
            }
            return service.chooseAttachments(workspaceId, picked)
          })
          .catch((error: unknown) => {
            throw toPublicAttachmentError('choose', error)
          })
    },
    {
      channel: IPC_CHANNELS.attachmentsRemoveDraft,
      invoke: (payload): Promise<ChatAttachment> =>
        Promise.resolve()
          .then(() => service.removeDraft(payload))
          .catch((error: unknown) => {
            throw toPublicAttachmentError('remove', error)
          })
    }
  ]
}
