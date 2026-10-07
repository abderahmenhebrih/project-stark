import { isAbsolute, join, relative, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { MAX_REQUEST_PATH_LENGTH } from './limits'
import { InvalidWorkspaceError } from '../workspace/errors'
import { WorkspaceEntryTypeError, WorkspacePathOutsideRootError } from './errors'

/**
 * Single authority for resolving workspace-relative paths.
 *
 * The workspace root always comes from the persisted Workspace record;
 * the relative path comes from the renderer and is treated as hostile.
 * Resolution is canonical (realpath on both sides, so symlinks cannot
 * smuggle a target outside) and containment uses proper path-relative
 * logic — never a raw string prefix, so `C:\project` and
 * `C:\project-evil` can never be confused.
 */

export interface ResolvedWorkspacePath {
  /** Canonical absolute target path, safe to pass to fs operations. */
  readonly absolutePath: string
  /** Normalized request form: '' for the root, '/' separators otherwise. */
  readonly relativePath: string
}

function foldCase(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value
}

function splitSegments(relativePath: string): string[] {
  const separator = sep === '\\' ? /[\\/]+/ : /\//
  return relativePath.split(separator)
}

/**
 * Resolves a renderer-supplied relative path inside a workspace root.
 * Rejects '..' anywhere (even paths that would stay inside), absolute
 * paths, drive/UNC prefixes, NUL bytes, and overlong input — before
 * touching the filesystem. Realpath containment then rejects anything
 * that escapes via symlinks, including sibling-prefix lookalikes.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath: unknown
): Promise<ResolvedWorkspacePath> {
  if (typeof relativePath !== 'string') {
    throw new InvalidWorkspaceError('workspace path must be a string')
  }
  // NUL byte written as an escape on purpose: no raw control bytes in source.
  if (relativePath.includes('\0')) {
    throw new InvalidWorkspaceError('workspace path is invalid')
  }
  if (relativePath.length > MAX_REQUEST_PATH_LENGTH) {
    throw new InvalidWorkspaceError('workspace path is too long')
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new InvalidWorkspaceError('workspace path must be relative')
  }
  if (!isAbsolute(workspaceRoot)) {
    throw new InvalidWorkspaceError('workspace root must be absolute')
  }
  const segments = splitSegments(relativePath).filter((segment) => segment !== '' && segment !== '.')
  for (const segment of segments) {
    if (segment === '..') {
      throw new WorkspacePathOutsideRootError()
    }
  }
  const canonicalRoot = await realpath(workspaceRoot)
  // Refuse symlinks segment by segment before canonicalizing: realpath
  // alone would silently resolve an inside-pointing link and lose the
  // fact that the request traversed one (Stage 6: no traversal, even
  // inside). A missing tail stops the walk; the final realpath below
  // then reports it as not found. A residual swap-between-checks race is
  // accepted (documented): every consumer re-checks with lstat anyway.
  let prefix = canonicalRoot
  for (const segment of segments) {
    prefix = join(prefix, segment)
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new WorkspaceEntryTypeError()
      }
    } catch (error) {
      if (error instanceof WorkspaceEntryTypeError) {
        throw error
      }
      break
    }
  }
  const joined = segments.length === 0 ? canonicalRoot : join(canonicalRoot, ...segments)
  const canonicalTarget = await realpath(joined)
  // Final backstop after the segment walk: catches anything canonicalization
  // itself relocates (e.g. mounted volumes or bind mounts inside the root),
  // plus the '..' cases already rejected above. Never a raw string prefix:
  // 'C:\project' and 'C:\project-evil' must not be confused.
  const difference = relative(foldCase(canonicalRoot), foldCase(canonicalTarget))
  if (difference !== '' && (difference.startsWith('..') || isAbsolute(difference))) {
    throw new WorkspacePathOutsideRootError()
  }
  return {
    absolutePath: canonicalTarget,
    relativePath: segments.join('/')
  }
}
