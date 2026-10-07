/**
 * Shared workspace-search domain contract.
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Bounded literal text search inside a persisted Workspace. Requests carry
 * only a workspace id plus a query; absolute host paths never cross this
 * boundary in either direction. Results carry workspace-relative paths
 * (forward slashes) with 1-based line/column display positions plus short
 * line-based previews — never absolute paths, never full file contents,
 * never Node objects. Human-facing search only; no AI consumption yet.
 */

/** Renderer-supplied search request. Workspace root resolves in main. */
export interface WorkspaceSearchRequest {
  readonly workspaceId: number
  readonly query: string
  readonly caseSensitive?: boolean
}

/** One literal occurrence inside one file. Line/column are 1-based. */
export interface WorkspaceSearchMatch {
  readonly relativePath: string
  readonly line: number
  readonly column: number
  readonly preview: string
}

/**
 * Bounded search result.
 *
 * - filesScanned = eligible text candidates actually read (bytes were
 *   loaded and decoded or attempted; sensitive/skipped/oversized files
 *   that were never read do NOT count).
 * - filesMatched = files producing >= 1 returned match.
 * - truncated = true when any global budget (result cap, file cap, byte
 *   cap, time cap) stopped the search early. Per-file caps limit one file
 *   without marking the whole search truncated.
 */
export interface WorkspaceSearchResult {
  readonly workspaceId: number
  readonly query: string
  readonly matches: readonly WorkspaceSearchMatch[]
  readonly filesScanned: number
  readonly filesMatched: number
  readonly truncated: boolean
}

/** Workspace-search slice of the preload bridge. */
export interface WorkspaceSearchApi {
  search: (request: WorkspaceSearchRequest) => Promise<WorkspaceSearchResult>
}
