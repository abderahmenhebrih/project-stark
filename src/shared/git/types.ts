/**
 * Shared Git domain contracts (Stage 12, read-only).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * All paths are repository-relative with forward slashes. Absolute
 * paths never cross IPC. Git state is live repository state; nothing
 * here is persisted (schema stays v3).
 */

/** Branch lifecycle: normal branch, detached HEAD, or unborn (no commits yet). */
export type GitBranchKind = 'branch' | 'detached' | 'unborn'

/** Branch/upstream/ahead-behind snapshot. Nulls are normal (no upstream). */
export interface GitBranchInfo {
  readonly kind: GitBranchKind
  readonly name: string | null
  readonly head: string | null
  readonly upstream: string | null
  readonly ahead: number | null
  readonly behind: number | null
}

/**
 * Single-character porcelain XY codes (plus untracked markers).
 * ' ' denotes unmodified on that side.
 */
export type GitStatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!'

/** One repository-relative file entry. Raw Git output is never exposed. */
export interface GitFileStatus {
  readonly relativePath: string
  readonly originalPath: string | null
  readonly indexStatus: GitStatusCode
  readonly worktreeStatus: GitStatusCode
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
}

/** Read-only workspace Git state. */
export type GitWorkspaceState =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-repository' }
  | { readonly kind: 'root-mismatch' }
  | {
      readonly kind: 'ready'
      readonly workspaceId: number
      readonly clean: boolean
      readonly branch: GitBranchInfo
      readonly files: readonly GitFileStatus[]
    }

/** Narrow status request: persisted workspace reference only. */
export interface GitStatusRequest {
  readonly workspaceId: number
}

/** Narrow diff request: validated repo-relative path plus fixed target. */
export interface GitDiffRequest {
  readonly workspaceId: number
  readonly relativePath: string
  readonly target: 'staged' | 'unstaged'
}

/** Plain-text patch result. Patch text is inert (never HTML). */
export interface GitDiffResult {
  readonly workspaceId: number
  readonly relativePath: string
  readonly target: 'staged' | 'unstaged'
  readonly patch: string
}

/** Renderer-facing Git bridge (see StarkApi in shared/types). */
export interface GitApi {
  getStatus: (workspaceId: number) => Promise<GitWorkspaceState>
  getDiff: (request: GitDiffRequest) => Promise<GitDiffResult>
}
