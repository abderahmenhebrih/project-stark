/**
 * Central limits for the Stage 11 human terminal.
 * Single definitions — no layer duplicates these numbers.
 */

/** xterm dimension bounds enforced in main (renderer clamps first). */
export const MIN_TERMINAL_COLS = 20
export const MAX_TERMINAL_COLS = 500
export const MIN_TERMINAL_ROWS = 5
export const MAX_TERMINAL_ROWS = 200

/** Default dimensions when the renderer has no laid-out size yet. */
export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24

/** Largest human-keystroke payload accepted per IPC write (64 KiB). */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024

/** Largest PTY output chunk forwarded per IPC data event (64 KiB). */
export const MAX_TERMINAL_OUTPUT_CHUNK_BYTES = 64 * 1024

/** Longest accepted opaque session id string. */
export const MAX_TERMINAL_SESSION_ID_LENGTH = 128

/** Graceful PTY shutdown wait before scoped forced cleanup (5s). */
export const TERMINAL_SHUTDOWN_TIMEOUT_MS = 5000

/** xterm visible scrollback lines (renderer-side, no persistence). */
export const TERMINAL_SCROLLBACK_LINES = 5000
