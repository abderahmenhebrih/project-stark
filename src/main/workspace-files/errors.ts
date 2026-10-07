/**
 * Workspace-files domain errors. Local base class (rather than reusing
 * the workspace base) keeps this module import-cycle free; the shared
 * toPublicError mapper in workspace/errors.ts still maps every one of
 * these to safe public copy via explicit instanceof checks.
 */

export class WorkspaceFilesError extends Error {
  override readonly name: string = 'WorkspaceFilesError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Requested path does not exist. */
export class WorkspacePathNotFoundError extends WorkspaceFilesError {
  override readonly name = 'WorkspacePathNotFoundError'

  constructor() {
    super('workspace path does not exist')
  }
}

/** Requested path escapes the workspace root. */
export class WorkspacePathOutsideRootError extends WorkspaceFilesError {
  override readonly name = 'WorkspacePathOutsideRootError'

  constructor() {
    super('workspace path escapes the workspace root')
  }
}

/** Target is the wrong kind (symlink, dir-as-file, file-as-dir). */
export class WorkspaceEntryTypeError extends WorkspaceFilesError {
  override readonly name = 'WorkspaceEntryTypeError'

  constructor() {
    super('workspace target has an unsupported kind')
  }
}

/** File exceeds the text-preview size limit. */
export class FileTooLargeError extends WorkspaceFilesError {
  override readonly name = 'FileTooLargeError'

  constructor() {
    super('file exceeds the text preview size limit')
  }
}

/** Content is not supported UTF-8 text. */
export class UnsupportedFileError extends WorkspaceFilesError {
  override readonly name = 'UnsupportedFileError'

  constructor() {
    super('file content is not supported text')
  }
}

/**
 * The file changed on disk after the renderer read it. The pending
 * write is refused outright — no force overwrite, no merge.
 */
export class WorkspaceFileConflictError extends WorkspaceFilesError {
  override readonly name = 'WorkspaceFileConflictError'

  constructor() {
    super('This file changed on disk. Reload it before saving your changes.')
  }
}

/** The atomic replacement itself failed after validation passed. */
export class WorkspaceFileWriteError extends WorkspaceFilesError {
  override readonly name = 'WorkspaceFileWriteError'

  constructor(options?: { cause?: unknown }) {
    super('workspace file could not be saved', options)
  }
}
