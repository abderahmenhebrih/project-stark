/**
 * Renderer-side terminal dimension defaults mirroring main limits.
 * Kept in a DOM-free module so pure state logic stays unit-testable
 * under the Node test build.
 */

export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24
export const MIN_TERMINAL_COLS = 20
export const MAX_TERMINAL_COLS = 500
export const MIN_TERMINAL_ROWS = 5
export const MAX_TERMINAL_ROWS = 200

/** xterm visible scrollback lines (display only, no persistence). */
export const TERMINAL_SCROLLBACK_LINES = 5000
