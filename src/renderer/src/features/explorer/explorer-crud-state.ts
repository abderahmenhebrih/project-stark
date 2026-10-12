/**
 * Pure inline file-operation state for Explorer CRUD (no React
 * imports) so create/rename interaction behavior is unit-testable
 * with the Node runner. The main process stays authoritative for
 * validation — this layer only tracks drafts and gives instant
 * feedback. Escape always cancels without any IPC; Enter commits
 * through the narrow CRUD bridge.
 */

export type ExplorerCrudKind = 'file' | 'directory'

/** Context-menu target: a tree row, or the workspace root itself. */
export interface ExplorerMenuTarget {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'root'
  readonly name: string
}

/** Inline creation row inside one parent directory ('' = root). */
export interface PendingExplorerCreate {
  readonly parentPath: string
  readonly kind: ExplorerCrudKind
  readonly draft: string
}

/** Inline rename of one selected entry (name stays in its parent). */
export interface PendingExplorerRename {
  readonly path: string
  readonly draft: string
}

/** Basename of one workspace-relative path ('' for the root). */export function explorerBasename(relativePath: string): string {
  if (relativePath === '') {
    return ''
  }
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? relativePath : relativePath.slice(slash + 1)
}

/** Parent of one workspace-relative path ('' for root-level entries). */
export function explorerParentOf(relativePath: string): string {
  if (relativePath === '') {
    return ''
  }
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? '' : relativePath.slice(0, slash)
}

/**
 * Instant draft feedback (main re-validates authoritatively). Returns
 * an inline error copy, or null when the draft looks committable.
 */
export function validateExplorerDraftName(draft: string): string | null {
  const name = draft.trim()
  if (name === '') {
    return 'Enter a name.'
  }
  if (name.length > 255) {
    return 'That name is too long.'
  }
  if (name.includes('/') || name.includes('\\')) {
    return 'Use a plain name without path separators.'
  }
  if (name === '.' || name === '..') {
    return 'That name isn’t valid.'
  }
  return null
}
