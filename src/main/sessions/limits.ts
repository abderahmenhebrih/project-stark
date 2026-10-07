/**
 * Central limits for Stage 13 persistent coding sessions.
 * Single definitions — no layer duplicates these numbers.
 */

/** Largest accepted user message, measured in exact UTF-8 bytes (64 KiB). */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** Longest session title, counted in Unicode code points. */
export const MAX_SESSION_TITLE_CODEPOINTS = 80

/** Most sessions returned per workspace history request. */
export const MAX_RECENT_SESSIONS = 50

/** Most messages returned per message-page request. */
export const MAX_MESSAGE_PAGE_SIZE = 100

/** Title assigned by the main process at session creation. */
export const NEW_SESSION_TITLE = 'New session' as const
