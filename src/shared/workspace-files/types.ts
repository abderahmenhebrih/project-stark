/**
 * Shared workspace-files domain contract.
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Read-only inspection of a persisted Workspace. Entries always carry
 * Workspace-relative paths (forward slashes, '' for the root); absolute
 * host paths never cross this boundary in either direction.
 */

/** Kind of a single directory entry. Symlinks stay visible but opaque. */
export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink' | 'other'

/** One entry of a directory listing. Size is null when not a file. */
export interface WorkspaceEntry {
  readonly name: string
  readonly relativePath: string
  readonly kind: WorkspaceEntryKind
  readonly size: number | null
}

/** Result of listing one directory. Never recursive. */
export interface WorkspaceDirectoryListing {
  readonly workspaceId: number
  readonly relativePath: string
  readonly entries: readonly WorkspaceEntry[]
  readonly truncated: boolean
}

/** Result of reading one small text file in full. */
export interface WorkspaceTextFile {
  readonly workspaceId: number
  readonly relativePath: string
  readonly content: string
  readonly size: number
  /**
   * SHA-256 of the exact file bytes (64 lowercase hex chars).
   * The renderer echoes this back as `expectedRevision` on save so a
   * stale write is rejected instead of clobbering external changes.
   */
  readonly revision: string
}

/** IPC request shape for workspace-scoped filesystem operations. */
export interface WorkspacePathRequest {
  readonly workspaceId: number
  readonly relativePath: string
}

/**
 * Save request for one EXISTING text file. Renderer supplies only the
 * persisted workspace id, the relative path, the revision it read, and
 * the new content — never an absolute path. No create/rename/move/copy.
 */
export interface WorkspaceTextFileWriteRequest {
  readonly workspaceId: number
  readonly relativePath: string
  readonly expectedRevision: string
  readonly content: string
}

/** Result of a stale-safe single-file write. */
export interface WorkspaceTextFileWriteResult {
  readonly workspaceId: number
  readonly relativePath: string
  readonly size: number
  readonly revision: string
  readonly changed: boolean
}

/** Workspace-files slice of the preload bridge. */
export interface WorkspaceFilesApi {
  listDirectory: (workspaceId: number, relativePath: string) => Promise<WorkspaceDirectoryListing>
  readTextFile: (workspaceId: number, relativePath: string) => Promise<WorkspaceTextFile>
  writeTextFile: (request: WorkspaceTextFileWriteRequest) => Promise<WorkspaceTextFileWriteResult>
}
