/**
 * Central limits for Stage 20 Looplink continuity.
 * Single definitions — no layer duplicates these numbers.
 */

/** Most source messages packed into one Looplink snapshot. */
export const MAX_LOOPLINK_MESSAGES = 12

/** Internal newest-first candidate cap before budget packing. */
export const MAX_LOOPLINK_MESSAGE_CANDIDATES = 30

/** Largest Worker result admitted to a snapshot, in exact UTF-8 bytes (32 KiB). */
export const MAX_LOOPLINK_WORKER_RESULT_BYTES = 32 * 1024

/** Most change references admitted to one snapshot. */
export const MAX_LOOPLINK_CHANGE_REFERENCES = 10

/** Largest complete snapshot payload, in exact UTF-8 bytes (128 KiB). */
export const MAX_LOOPLINK_PAYLOAD_BYTES = 128 * 1024

/** Most handoffs returned by one source-history lookup. */
export const MAX_RECENT_LOOPLINKS = 20
