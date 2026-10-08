/**
 * Shared explicit project-context domain contract (Stage 15, 15B).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Context is strictly explicit: the AI receives only items the user
 * attached through a visible action. Drafts are renderer-local until
 * send; the main process re-resolves every file-based item from disk
 * at send time, so renderer-supplied file content is never trusted.
 * Only manual-note content may originate from renderer text.
 *
 * Stage 15B: every file-backed draft carries `sourceRevision` (SHA-256
 * of the exact bytes the preview was extracted from). Send fails stale
 * when disk moved — never silent substitution.
 */

/** Where an attached context item came from. */
export type SessionContextKind = 'file-excerpt' | 'whole-file' | 'search-match' | 'manual-note'

/** File-backed draft kinds: pinned to an on-disk SHA-256 revision. */
export type FileSessionContextKind = 'file-excerpt' | 'whole-file' | 'search-match'

/**
 * A file-backed unsent draft. `sourceRevision` is the SHA-256 (64
 * lowercase hex) of the exact file bytes the preview was extracted
 * from. The main process re-reads the file at send time and rejects
 * the send when the current revision differs — never substituting
 * new content silently.
 */
export interface FileSessionContextDraft {
  readonly draftId: string
  readonly kind: FileSessionContextKind
  readonly label: string
  readonly relativePath: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly content: string
  readonly contentBytes: number
  readonly sourceRevision: string
}

/**
 * A manual-note unsent draft. The only renderer-originated content.
 * Carries no file revision.
 */
export interface ManualNoteSessionContextDraft {
  readonly draftId: string
  readonly kind: 'manual-note'
  readonly label: string
  readonly relativePath: null
  readonly lineStart: null
  readonly lineEnd: null
  readonly content: string
  readonly contentBytes: number
}

/**
 * An unsent draft. `draftId` is a main-issued opaque handle for
 * renderer list management only — the main process ignores it at
 * send time and re-resolves file items from disk, keyed by
 * workspaceId + relativePath + range + sourceRevision.
 */
export type SessionContextDraft = FileSessionContextDraft | ManualNoteSessionContextDraft

/** A persisted context item attached to one message. */
export interface SessionContextItem {
  readonly id: number
  readonly messageId: number
  readonly kind: SessionContextKind
  readonly label: string
  readonly relativePath: string | null
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
  readonly contentBytes: number
  readonly createdAt: number
}

/** Prepare a file excerpt: 1-based inclusive line range. */
export interface PrepareFileExcerptRequest {
  readonly workspaceId: number
  readonly relativePath: string
  readonly lineStart: number
  readonly lineEnd: number
}

/** Prepare a whole text file. */
export interface PrepareWholeFileRequest {
  readonly workspaceId: number
  readonly relativePath: string
}

/** Prepare the excerpt window around one search-match line (1-based). */
export interface PrepareSearchMatchRequest {
  readonly workspaceId: number
  readonly relativePath: string
  readonly line: number
}

/** Prepare a manual note. The only renderer-originated content. */
export interface PrepareManualNoteRequest {
  readonly workspaceId: number
  readonly label?: string
  readonly content: string
}

/** Context slice of the preload bridge (`window.stark.sessionContext`). */
export interface SessionContextApi {
  prepareExcerpt: (request: PrepareFileExcerptRequest) => Promise<SessionContextDraft>
  prepareFile: (request: PrepareWholeFileRequest) => Promise<SessionContextDraft>
  prepareSearchMatch: (request: PrepareSearchMatchRequest) => Promise<SessionContextDraft>
  prepareNote: (request: PrepareManualNoteRequest) => Promise<SessionContextDraft>
}
