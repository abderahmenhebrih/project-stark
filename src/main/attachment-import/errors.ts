/**
 * Attachment-import domain errors (Step 3).
 *
 * Public messages are stable user-facing copy: the renderer
 * normalizer recognizes exactly these strings, so they never
 * contain attachment IDs, absolute paths, store internals, SQL, or
 * stack traces. Internal causes stay in the main process only.
 */

/** Stable copy for an unknown or unresolvable attachment reference. */
export const ATTACHMENT_IMPORT_MISSING_MESSAGE = 'We couldn’t find that attachment.'

/** Stable copy for a draft (uncommitted) attachment that cannot be imported. */
export const ATTACHMENT_IMPORT_UNCOMMITTED_MESSAGE = 'That attachment hasn’t been sent yet.'

/** Stable copy for an attachment from another session. */
export const ATTACHMENT_IMPORT_SCOPE_MESSAGE = 'That attachment doesn’t belong to this conversation.'

/** Stable copy for an unsafe workspace destination. */
export const ATTACHMENT_IMPORT_UNSAFE_MESSAGE = 'That destination is not safe.'

/** Stable copy for an already-existing destination (no overwrite in v1). */
export const ATTACHMENT_IMPORT_EXISTS_MESSAGE = 'Destination already exists.'

/** Stable copy for a destination directory that does not exist. */
export const ATTACHMENT_IMPORT_NO_PARENT_MESSAGE = 'The destination folder does not exist.'

/** Stable copy for a stale import (attachment or destination moved under review). */
export const ATTACHMENT_IMPORT_STALE_MESSAGE = 'That attachment import is stale. Review it again.'

/** Stable copy for a gone workspace. */
export const ATTACHMENT_IMPORT_WORKSPACE_GONE_MESSAGE = 'That project folder is no longer available.'

/** Stable copy for an unknown import transaction. */
export const ATTACHMENT_IMPORT_NOT_FOUND_MESSAGE = 'That change is no longer available.'

/** Stable copy for illegal lifecycle transitions. */
export const ATTACHMENT_IMPORT_STATE_MESSAGE = 'That change can’t be updated in its current state.'

/** Fallback copy for anything unexpected. */
export const ATTACHMENT_IMPORT_GENERIC_MESSAGE = 'We couldn’t import that attachment.'

export class AttachmentImportError extends Error {
  override readonly name: string = 'AttachmentImportError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Referenced attachment id is unknown to the store. */
export class AttachmentImportMissingError extends AttachmentImportError {
  override readonly name: string = 'AttachmentImportMissingError'

  constructor() {
    super(ATTACHMENT_IMPORT_MISSING_MESSAGE)
  }
}

/** Referenced attachment is an uncommitted draft. */
export class AttachmentImportUncommittedError extends AttachmentImportError {
  override readonly name: string = 'AttachmentImportUncommittedError'

  constructor() {
    super(ATTACHMENT_IMPORT_UNCOMMITTED_MESSAGE)
  }
}

/** Referenced attachment belongs to another session. */
export class AttachmentImportScopeError extends AttachmentImportError {
  override readonly name: string = 'AttachmentImportScopeError'

  constructor() {
    super(ATTACHMENT_IMPORT_SCOPE_MESSAGE)
  }
}

/** Proposed destination fails workspace safety rules. */
export class UnsafeAttachmentDestinationError extends AttachmentImportError {
  override readonly name: string = 'UnsafeAttachmentDestinationError'

  constructor() {
    super(ATTACHMENT_IMPORT_UNSAFE_MESSAGE)
  }
}

/** Destination already exists — v1 never overwrites. */
export class AttachmentDestinationExistsError extends AttachmentImportError {
  override readonly name: string = 'AttachmentDestinationExistsError'

  constructor() {
    super(ATTACHMENT_IMPORT_EXISTS_MESSAGE)
  }
}

/** Destination parent directory does not exist. */
export class AttachmentDestinationParentMissingError extends AttachmentImportError {
  override readonly name: string = 'AttachmentDestinationParentMissingError'

  constructor() {
    super(ATTACHMENT_IMPORT_NO_PARENT_MESSAGE)
  }
}

/** Reviewed bytes or destination state moved — fail closed. */
export class StaleAttachmentImportError extends AttachmentImportError {
  override readonly name: string = 'StaleAttachmentImportError'

  constructor() {
    super(ATTACHMENT_IMPORT_STALE_MESSAGE)
  }
}

/** Import transaction is unknown or not a binary import. */
export class AttachmentImportTransactionNotFoundError extends AttachmentImportError {
  override readonly name: string = 'AttachmentImportTransactionNotFoundError'

  constructor() {
    super(ATTACHMENT_IMPORT_NOT_FOUND_MESSAGE)
  }
}

/** Illegal lifecycle transition. */
export class AttachmentImportStateError extends AttachmentImportError {
  override readonly name: string = 'AttachmentImportStateError'

  constructor() {
    super(ATTACHMENT_IMPORT_STATE_MESSAGE)
  }
}
