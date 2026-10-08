/**
 * Central limits for Stage 15 explicit project context.
 * Single definitions — no layer duplicates these numbers.
 */

/** Most context items attached to one message. */
export const MAX_CONTEXT_ITEMS = 20

/** Largest single context item, in exact UTF-8 bytes (32 KiB). */
export const MAX_CONTEXT_ITEM_BYTES = 32 * 1024

/** Largest combined attached context per message, in UTF-8 bytes (200 KiB). */
export const MAX_TOTAL_CONTEXT_BYTES = 200 * 1024

/** Largest manual-note body, in exact UTF-8 bytes (16 KiB). */
export const MAX_MANUAL_NOTE_BYTES = 16 * 1024

/** Longest context label, in Unicode code points. */
export const MAX_CONTEXT_LABEL_CODEPOINTS = 120

/** Search-match excerpt window: lines kept on each side of the hit. */
export const SEARCH_MATCH_CONTEXT_RADIUS = 3
