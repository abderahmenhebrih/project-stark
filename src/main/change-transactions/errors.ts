import { DatabaseError } from '../database/errors'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspaceFileConflictError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from '../workspace-files/errors'
import {
  InvalidWorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError
} from '../workspace/errors'
import {
  ATTACHMENT_IMPORT_GENERIC_MESSAGE,
  AttachmentDestinationExistsError,
  AttachmentDestinationParentMissingError,
  AttachmentImportError,
  AttachmentImportMissingError,
  AttachmentImportScopeError,
  AttachmentImportStateError,
  AttachmentImportTransactionNotFoundError,
  AttachmentImportUncommittedError,
  StaleAttachmentImportError,
  UnsafeAttachmentDestinationError
} from '../attachment-import/errors'

/**
 * Change-transaction domain errors.
 *
 * Public messages are stable user-facing copy: the renderer normalizer
 * recognizes exactly these strings, so they must never contain paths,
 * values, database internals, or stack traces. Internal causes stay in
 * the main process only.
 */

/** Stable copy for a stale checkpoint or stale accept. */
export const CHANGE_CONFLICT_MESSAGE = 'This file changed on disk. Reload it before saving your changes.'

/** Stable copy for a stale rollback guard. */
export const CHANGE_ROLLBACK_CONFLICT_MESSAGE =
  'This file changed on disk. Reload it before rolling back this change.'

/** Stable copy for oversized proposals. */
export const CHANGE_TOO_LARGE_MESSAGE = 'This file is too large to save with the current editor.'

/** Stable copy for non-text proposals or originals. */
export const CHANGE_UNSUPPORTED_MESSAGE = 'This file isn’t a supported text file.'

/** Stable copy for illegal lifecycle transitions. */
export const CHANGE_STATE_MESSAGE = 'That change can’t be updated in its current state.'

/** Stable copy for proposals with no effective edit. */
export const CHANGE_NO_CHANGES_MESSAGE = 'There are no changes to review.'

/** Stable copy for integrity failures. */
export const CHANGE_CORRUPT_MESSAGE = 'That change’s stored data can’t be used.'

/** Stable copy for unknown transaction ids. */
export const CHANGE_NOT_FOUND_MESSAGE = 'That change is no longer available.'

/** Stable copy for a workspace that is gone. */
export const CHANGE_WORKSPACE_GONE_MESSAGE = 'That project folder is no longer available.'

/** Fallback copy for anything unexpected. */
export const CHANGE_GENERIC_MESSAGE = 'We couldn’t update this change.'

export class ChangeTransactionError extends Error {
  override readonly name: string = 'ChangeTransactionError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** No transaction exists for the requested ID. */
export class ChangeTransactionNotFoundError extends ChangeTransactionError {
  override readonly name = 'ChangeTransactionNotFoundError'

  constructor() {
    super(CHANGE_NOT_FOUND_MESSAGE)
  }
}

/** The requested transition is forbidden from the current status. */
export class ChangeTransactionStateError extends ChangeTransactionError {
  override readonly name = 'ChangeTransactionStateError'

  constructor() {
    super(CHANGE_STATE_MESSAGE)
  }
}

/** The proposal matches the current bytes exactly: nothing to review. */
export class ChangeTransactionNoChangesError extends ChangeTransactionError {
  override readonly name = 'ChangeTransactionNoChangesError'

  constructor() {
    super(CHANGE_NO_CHANGES_MESSAGE)
  }
}

/**
 * The disk moved under a checkpoint (stale create/accept) or under an
 * applied revision (stale rollback). The message is fixed at throw time
 * to the operation-appropriate canonical copy.
 */
export class ChangeTransactionConflictError extends ChangeTransactionError {
  override readonly name = 'ChangeTransactionConflictError'
}

/** Stored bytes fail hash or decode verification. Never applied. */
export class CorruptChangeTransactionError extends ChangeTransactionError {
  override readonly name = 'CorruptChangeTransactionError'

  constructor() {
    super(CHANGE_CORRUPT_MESSAGE)
  }
}

/**
 * Maps any transaction-layer failure to a renderer-safe Error carrying
 * displayable copy. Only the canonical constants above (plus the shared
 * workspace copies) ever cross IPC.
 */
export function toPublicChangeError(error: unknown): Error {
  if (
    error instanceof ChangeTransactionConflictError ||
    error instanceof ChangeTransactionStateError ||
    error instanceof ChangeTransactionNoChangesError ||
    error instanceof CorruptChangeTransactionError ||
    error instanceof ChangeTransactionNotFoundError
  ) {
    return new Error(error.message)
  }
  // Binary attachment-import failures (Step 3) carry stable
  // user-facing copy; anything unexpected collapses to the import
  // fallback — never paths, IDs, or internals.
  if (
    error instanceof AttachmentImportMissingError ||
    error instanceof AttachmentImportUncommittedError ||
    error instanceof AttachmentImportScopeError ||
    error instanceof UnsafeAttachmentDestinationError ||
    error instanceof AttachmentDestinationExistsError ||
    error instanceof AttachmentDestinationParentMissingError ||
    error instanceof StaleAttachmentImportError ||
    error instanceof AttachmentImportTransactionNotFoundError ||
    error instanceof AttachmentImportStateError
  ) {
    return new Error(error.message)
  }
  if (error instanceof AttachmentImportError) {
    return new Error(ATTACHMENT_IMPORT_GENERIC_MESSAGE)
  }
  if (error instanceof WorkspaceFileConflictError) {
    return new Error(CHANGE_CONFLICT_MESSAGE)
  }
  if (error instanceof FileTooLargeError) {
    return new Error(CHANGE_TOO_LARGE_MESSAGE)
  }
  if (error instanceof UnsupportedFileError) {
    return new Error(CHANGE_UNSUPPORTED_MESSAGE)
  }
  if (error instanceof WorkspaceNotFoundError || error instanceof WorkspaceUnavailableError) {
    return new Error(CHANGE_WORKSPACE_GONE_MESSAGE)
  }
  if (
    error instanceof WorkspacePathNotFoundError ||
    error instanceof WorkspacePathOutsideRootError ||
    error instanceof WorkspaceEntryTypeError ||
    error instanceof InvalidWorkspaceError ||
    error instanceof DatabaseError
  ) {
    return new Error(CHANGE_GENERIC_MESSAGE)
  }
  return new Error(CHANGE_GENERIC_MESSAGE)
}
