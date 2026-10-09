/**
 * Pure Error Boundary copy + state (no React imports) so the release
 * fallback contract is unit-testable with the Node runner. The
 * component in ./ErrorBoundary.tsx stays a thin wrapper around this.
 */

/** Fixed display-error copy. No stacks, no paths, no secrets. */
export const DISPLAY_ERROR_MESSAGE = 'STARK encountered a display error.'

/** Reload must be side-effect free beyond re-rendering. */
export const DISPLAY_ERROR_RELOAD_LABEL = 'Reload interface'

export interface ErrorBoundaryState {
  readonly hasError: boolean
}

/** Derives boundary state from a caught render error (content ignored). */
export function errorBoundaryStateFor(error: unknown): ErrorBoundaryState {
  void error
  return { hasError: true }
}

/** Initial boundary state: no error. */
export function initialErrorBoundaryState(): ErrorBoundaryState {
  return { hasError: false }
}
