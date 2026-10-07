import { DatabaseError } from '../database/errors'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspaceFileConflictError,
  WorkspaceFileWriteError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from '../workspace-files/errors'
import { InvalidSearchQueryError } from '../workspace-search/errors'

/**
 * Workspace domain errors.
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain paths, values, database internals,
 * or stack traces. Internal causes are preserved for main-process
 * diagnostics only.
 */

export class WorkspaceError extends Error {
  override readonly name: string = 'WorkspaceError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A workspace ID or payload failed runtime validation. */
export class InvalidWorkspaceError extends WorkspaceError {
  override readonly name = 'InvalidWorkspaceError'
}

/** No workspace exists for the requested ID. */
export class WorkspaceNotFoundError extends WorkspaceError {
  override readonly name = 'WorkspaceNotFoundError'

  constructor() {
    super('That project folder is no longer available.')
  }
}

/** The workspace directory is gone or inaccessible. */
export class WorkspaceUnavailableError extends WorkspaceError {
  override readonly name = 'WorkspaceUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('That project folder is no longer available.', options)
  }
}

export type WorkspaceOperation =
  | 'get-current'
  | 'list-recent'
  | 'choose-directory'
  | 'open'
  | 'list-directory'
  | 'read-text-file'
  | 'write-text-file'
  | 'search'

/**
 * Maps any service-layer failure to a renderer-safe Error carrying
 * displayable copy. Database internals, paths, and stacks never cross IPC.
 */
export function toPublicError(operation: WorkspaceOperation, error: unknown): Error {
  if (error instanceof WorkspaceNotFoundError || error instanceof WorkspaceUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof WorkspaceFileConflictError) {
    return new Error('This file changed on disk. Reload it before saving your changes.')
  }
  if (error instanceof FileTooLargeError) {
    if (operation === 'write-text-file') {
      return new Error('This file is too large to save.')
    }
    return new Error('This file is too large to preview.')
  }
  if (error instanceof UnsupportedFileError) {
    return new Error('This file isn’t a supported text file.')
  }
  if (error instanceof WorkspaceFileWriteError) {
    return new Error('We couldn’t save this file.')
  }
  if (
    error instanceof WorkspacePathNotFoundError ||
    error instanceof WorkspacePathOutsideRootError ||
    error instanceof WorkspaceEntryTypeError
  ) {
    if (operation === 'read-text-file') {
      return new Error('We couldn’t read this file.')
    }
    if (operation === 'write-text-file') {
      return new Error('We couldn’t save this file.')
    }
    if (operation === 'list-directory') {
      return new Error('We couldn’t read this folder.')
    }
  }
  if (error instanceof InvalidWorkspaceError) {
    if (operation === 'list-directory') {
      return new Error('We couldn’t read this folder.')
    }
  if (operation === 'read-text-file') {
    return new Error('We couldn’t read this file.')
  }
  if (operation === 'write-text-file') {
    return new Error('We couldn’t save this file.')
  }
  if (operation === 'search') {
    return new Error('We couldn’t search this project.')
  }
  return new Error('We couldn’t open that project folder.')
}
  if (error instanceof InvalidSearchQueryError) {
    return new Error('We couldn’t search this project.')
  }
  if (error instanceof DatabaseError) {
    if (operation === 'get-current' || operation === 'list-recent') {
      return new Error('We couldn’t load your workspaces.')
    }
    if (operation === 'list-directory') {
      return new Error('We couldn’t read this folder.')
    }
    if (operation === 'read-text-file') {
      return new Error('We couldn’t read this file.')
    }
    if (operation === 'write-text-file') {
      return new Error('We couldn’t save this file.')
    }
    if (operation === 'search') {
      return new Error('We couldn’t search this project.')
    }
    return new Error('We couldn’t open that project folder.')
  }
  if (operation === 'get-current' || operation === 'list-recent') {
    return new Error('We couldn’t load your workspaces.')
  }
  if (operation === 'list-directory') {
    return new Error('We couldn’t read this folder.')
  }
    if (operation === 'read-text-file') {
      return new Error('We couldn’t read this file.')
    }
    if (operation === 'write-text-file') {
      return new Error('We couldn’t save this file.')
    }
    if (operation === 'search') {
      return new Error('We couldn’t search this project.')
    }
    return new Error('We couldn’t open that project folder.')
  }
