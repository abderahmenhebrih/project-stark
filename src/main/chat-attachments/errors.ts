/**
 * Chat-attachment domain errors.
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain absolute paths, storage paths,
 * file contents, environment values, or stack traces. Internal causes
 * stay in main-process diagnostics only.
 */

export class ChatAttachmentError extends Error {
  override readonly name: string = 'ChatAttachmentError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Attachment request payload failed runtime validation. */
export class InvalidAttachmentRequestError extends ChatAttachmentError {
  override readonly name = 'InvalidAttachmentRequestError'

  constructor() {
    super('That attachment request is not valid.')
  }
}

/** Referenced attachment id is unknown to the store. */
export class AttachmentNotFoundError extends ChatAttachmentError {
  override readonly name = 'AttachmentNotFoundError'

  constructor() {
    super('We couldn’t find that attachment.')
  }
}

/** A picked file violates type/size/shape bounds. */
export class UnsupportedAttachmentError extends ChatAttachmentError {
  override readonly name = 'UnsupportedAttachmentError'

  constructor() {
    super('That file can’t be attached.')
  }
}

/** One attachment exceeds the per-file byte bound. */
export class AttachmentTooLargeError extends ChatAttachmentError {
  override readonly name = 'AttachmentTooLargeError'

  constructor() {
    super('That file is too large to attach.')
  }
}

/** More than MAX_ATTACHMENTS_PER_MESSAGE linked to one message. */
export class TooManyAttachmentsError extends ChatAttachmentError {
  override readonly name = 'TooManyAttachmentsError'

  constructor() {
    super('Too many attachments for one message.')
  }
}

/** Aggregate attachment bytes exceed the per-message bound. */
export class TotalAttachmentsTooLargeError extends ChatAttachmentError {
  override readonly name = 'TotalAttachmentsTooLargeError'

  constructor() {
    super('Those attachments are too large altogether.')
  }
}

export type AttachmentOperation = 'choose' | 'send' | 'remove' | 'serve'

/**
 * Maps any attachment-layer failure to a renderer-safe Error carrying
 * displayable copy only. Unknown failures collapse to the generic
 * copy for the operation in progress.
 */
export function toPublicAttachmentError(operation: AttachmentOperation, error: unknown): Error {
  if (error instanceof InvalidAttachmentRequestError) {
    return new Error(error.message)
  }
  if (error instanceof AttachmentNotFoundError) {
    return new Error(error.message)
  }
  if (error instanceof UnsupportedAttachmentError) {
    return new Error(error.message)
  }
  if (error instanceof AttachmentTooLargeError) {
    return new Error(error.message)
  }
  if (error instanceof TooManyAttachmentsError) {
    return new Error(error.message)
  }
  if (error instanceof TotalAttachmentsTooLargeError) {
    return new Error(error.message)
  }
  if (error instanceof ChatAttachmentError) {
    return new Error('We couldn’t handle that attachment.')
  }
  switch (operation) {
    case 'choose':
      return new Error('We couldn’t attach those files.')
    case 'send':
      return new Error('We couldn’t send those attachments.')
    case 'remove':
      return new Error('We couldn’t remove that attachment.')
    case 'serve':
      return new Error('We couldn’t load that attachment.')
  }
}
