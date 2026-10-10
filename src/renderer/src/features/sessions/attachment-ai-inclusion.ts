import type { ChatAttachment } from '../../../../shared/chat-attachments/types'
import { attachmentInclusionFor } from '../../../../shared/ai/attachment-capabilities'

/**
 * Subtle model-understanding state for one message attachment card
 * (Step 2 §13). Pure and display-only: the authoritative inclusion
 * decision stays main-side per provider call. Returns the exact
 * helper copy or null when no state applies (unknown model,
 * non-image attachments, and metadata-only oversize images stay
 * quiet to avoid noisy badges everywhere).
 */
export function attachmentAiState(attachment: ChatAttachment, selectedModel: string | null): string | null {
  if (attachment.kind !== 'image' || selectedModel === null || selectedModel === '') {
    return null
  }
  const inclusion = attachmentInclusionFor('openai', selectedModel, {
    kind: attachment.kind,
    name: attachment.name,
    size: attachment.size
  })
  if (inclusion === 'included-image') {
    return 'Included in AI context'
  }
  if (inclusion === 'unsupported') {
    return 'Model cannot view this image'
  }
  return null
}
