/**
 * Shared chat-attachment domain contract (local files + images).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Attachments are LOCAL and INERT: main copies picked files into
 * STARK-owned userData storage, and the renderer learns normalized
 * metadata only (never source or storage paths). Images render
 * through the narrow stark-attachment:// protocol by opaque ID.
 * Nothing here is sent to any AI provider.
 */

/** Attachment payload kind: inline-previewable image vs generic file. */
export type ChatAttachmentKind = 'image' | 'file'

/**
 * One normalized attachment. IDs are main-generated opaque handles;
 * `name` is display-only metadata (never a disk path).
 */
export interface ChatAttachment {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly kind: ChatAttachmentKind
}

/** Renderer → main file-picker request. No paths cross this boundary. */
export interface ChooseAttachmentsRequest {
  readonly workspaceId: number
}

/** Attachments slice of the preload bridge (`window.stark.attachments`). */
export interface ChatAttachmentsApi {
  choose: (request: ChooseAttachmentsRequest) => Promise<readonly ChatAttachment[]>
  removeDraft: (attachmentId: string) => Promise<ChatAttachment>
}
