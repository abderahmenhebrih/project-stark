import type { ChatAttachment } from '../../../shared/chat-attachments/types'
import { getStarkApi } from './stark-api'

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Chat attachments are unavailable.'))
}

/**
 * Typed chat-attachment callers.
 *
 * Files are picked through the main-owned native dialog and stored
 * main-side; components handle normalized metadata only. No polling
 * here: callers act explicitly (attach button, remove, send).
 */
export function chooseChatAttachments(workspaceId: number): Promise<readonly ChatAttachment[]> {
  const api = getStarkApi()?.attachments.choose
  if (api === undefined) {
    return unavailable()
  }
  return api({ workspaceId })
}

export function removeChatAttachmentDraft(attachmentId: string): Promise<ChatAttachment> {
  const api = getStarkApi()?.attachments.removeDraft
  if (api === undefined) {
    return unavailable()
  }
  return api(attachmentId)
}
