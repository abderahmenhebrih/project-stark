/**
 * Shared document-formatter domain contracts (Prettier pilot).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * The renderer sends workspace identity plus a workspace-relative
 * path only — never file text, never absolute paths. Main reads the
 * authoritative snapshot, runs the allowlisted formatter inside the
 * Extension Host, and returns the snapshot revision plus the formatted
 * text. The renderer then proposes (never writes) through the
 * existing change-transaction pipeline.
 */

/** Narrow format request: workspace + relative path only. */
export interface FormatDocumentRequest {
  readonly workspaceId: number
  readonly relativePath: string
}

/**
 * Format outcome: the snapshot revision main formatted (the renderer
 * must use it as expectedRevision, so mid-format edits reject as
 * stale) plus the formatted text. Equal-to-input text means already
 * formatted — the renderer creates no transaction then.
 */
export interface FormatDocumentResult {
  readonly revision: string
  readonly afterText: string
}

/** Renderer-facing formatter bridge (see StarkApi in shared/types). */
export interface FormatterApi {
  formatDocument: (request: FormatDocumentRequest) => Promise<FormatDocumentResult>
}
