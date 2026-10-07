/**
 * Workspace-search domain errors.
 *
 * Standalone base class (no import from workspace/errors) keeps this module
 * import-cycle free: workspace/errors.ts imports from here for public-error
 * mapping, never the reverse. Services may still throw the shared
 * WorkspaceNotFoundError / WorkspaceUnavailableError for workspace-level
 * failures; query-level failures use InvalidSearchQueryError below.
 */

export class WorkspaceSearchError extends Error {
  override readonly name: string = 'WorkspaceSearchError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** The search request or query failed runtime validation. */
export class InvalidSearchQueryError extends WorkspaceSearchError {
  override readonly name = 'InvalidSearchQueryError'

  constructor(message: string = 'search query is invalid') {
    super(message)
  }
}
