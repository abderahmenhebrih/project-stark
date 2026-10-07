/**
 * Git domain errors (Stage 12, read-only).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain absolute paths, executable paths,
 * spawn details, environment values, or stack traces. Internal causes
 * stay in main-process diagnostics only.
 */

export class GitError extends Error {
  override readonly name: string = 'GitError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Request payload failed runtime validation. */
export class InvalidGitRequestError extends GitError {
  override readonly name = 'InvalidGitRequestError'
}

/** The `git` executable is not available. */
export class GitUnavailableError extends GitError {
  override readonly name = 'GitUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('Git is not available on this system.', options)
  }
}

/** Workspace root is not inside a Git working tree. */
export class GitNotRepositoryError extends GitError {
  override readonly name = 'GitNotRepositoryError'

  constructor() {
    super('No Git repository detected.')
  }
}

/** Workspace is a subfolder of a parent repository (refused). */
export class GitRootMismatchError extends GitError {
  override readonly name = 'GitRootMismatchError'

  constructor() {
    super(
      'This folder is inside a Git repository. Open the repository root as the workspace to use Git integration.'
    )
  }
}

/** Bare or non-working-tree repository (unsupported in Stage 12). */
export class GitUnsupportedRepositoryError extends GitError {
  override readonly name = 'GitUnsupportedRepositoryError'

  constructor() {
    super('This repository type is not supported.')
  }
}

/** The persisted workspace folder is gone or inaccessible. */
export class GitWorkspaceUnavailableError extends GitError {
  override readonly name = 'GitWorkspaceUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('That project folder is no longer available.', options)
  }
}

/** Git refused the repository due to ownership/safe.directory policy. */
export class GitSafeDirectoryError extends GitError {
  override readonly name = 'GitSafeDirectoryError'

  constructor(options?: { cause?: unknown }) {
    super(
      'Git refused this repository because of its ownership/safety settings. ' +
        'Resolve the Git safe.directory configuration manually.',
      options
    )
  }
}

/** Status output exceeded its bounded limit. */
export class GitStatusTooLargeError extends GitError {
  override readonly name = 'GitStatusTooLargeError'

  constructor() {
    super('Git status is too large to display.')
  }
}

/** Diff output exceeded its bounded limit. */
export class GitDiffTooLargeError extends GitError {
  override readonly name = 'GitDiffTooLargeError'

  constructor() {
    super('This Git diff is too large to display.')
  }
}

/** Bounded Git execution timed out (single attempt, no retry). */
export class GitTimeoutError extends GitError {
  override readonly name = 'GitTimeoutError'

  constructor(options?: { cause?: unknown }) {
    super('Git operation timed out.', options)
  }
}

/** Parsed Git output was malformed. */
export class GitParseError extends GitError {
  override readonly name = 'GitParseError'

  constructor(options?: { cause?: unknown }) {
    super('Git output could not be understood.', options)
  }
}

/** Requested path is not in the current repository status. */
export class GitPathNotInStatusError extends GitError {
  override readonly name = 'GitPathNotInStatusError'

  constructor() {
    super('We couldn’t read this Git diff.')
  }
}

/** Untracked files have no Git diff; open the file instead. */
export class GitUntrackedNoDiffError extends GitError {
  override readonly name = 'GitUntrackedNoDiffError'

  constructor() {
    super('This file is untracked. Open the file to view its contents.')
  }
}

export type GitOperation = 'status' | 'diff'

function isSafeDirectoryFailure(stderr: string): boolean {
  const lowered = stderr.toLowerCase()
  return lowered.includes('safe.directory') || lowered.includes('dubious ownership')
}

/** Classifies raw stderr text for safe.directory mapping (pure, testable). */
export function classifyGitStderr(stderr: string): 'safe-directory' | 'not-repository' | 'other' {
  if (isSafeDirectoryFailure(stderr)) {
    return 'safe-directory'
  }
  const lowered = stderr.toLowerCase()
  if (lowered.includes('not a git repository')) {
    return 'not-repository'
  }
  return 'other'
}

/**
 * Maps any Git-layer failure to a renderer-safe Error carrying
 * displayable copy only. Unavailable/not-repository/root-mismatch are
 * normally returned as state, not thrown — this mapping covers the
 * remaining operation failures plus defensive re-mapping.
 */
export function toPublicGitError(operation: GitOperation, error: unknown): Error {
  if (error instanceof GitUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof GitNotRepositoryError) {
    return new Error(error.message)
  }
  if (error instanceof GitRootMismatchError) {
    return new Error(error.message)
  }
  if (error instanceof GitSafeDirectoryError) {
    return new Error(error.message)
  }
  if (error instanceof GitStatusTooLargeError) {
    return new Error(error.message)
  }
  if (error instanceof GitDiffTooLargeError) {
    return new Error(error.message)
  }
  if (error instanceof GitUnsupportedRepositoryError) {
    return new Error(error.message)
  }
  if (error instanceof GitWorkspaceUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof GitUntrackedNoDiffError) {
    return new Error(error.message)
  }
  if (error instanceof GitPathNotInStatusError) {
    return new Error(error.message)
  }
  if (error instanceof InvalidGitRequestError) {
    return new Error(operation === 'diff' ? 'We couldn’t read this Git diff.' : 'We couldn’t read Git status.')
  }
  if (error instanceof GitTimeoutError) {
    return new Error(operation === 'diff' ? 'We couldn’t read this Git diff.' : 'We couldn’t read Git status.')
  }
  if (error instanceof GitParseError) {
    return new Error(operation === 'diff' ? 'We couldn’t read this Git diff.' : 'We couldn’t read Git status.')
  }
  if (error instanceof GitError) {
    return new Error(operation === 'diff' ? 'We couldn’t read this Git diff.' : 'We couldn’t read Git status.')
  }
  return new Error(operation === 'diff' ? 'We couldn’t read this Git diff.' : 'We couldn’t read Git status.')
}
