/**
 * Central limits for Stage 23 read-only Worker tools.
 * Single definitions — no layer duplicates these numbers.
 */

/** Max tool calls per Work run (allowed/denied/approval/failure all count). */
export const MAX_WORKER_TOOL_CALLS = 4

/** Max Worker provider turns per run (initial + one follow-up per tool). */
export const MAX_WORKER_TURNS = 5

/** Max provider calls for a tool-enabled Work run (1 plan + 5 worker + 1 synthesis). */
export const MAX_TOOL_WORK_PROVIDER_CALLS = 7

/** Largest single Worker file read, exact UTF-8 bytes (64 KiB, no truncation). */
export const MAX_WORKER_READ_BYTES = 64 * 1024

/** Longest Worker search query, Unicode code points. */
export const MAX_WORKER_SEARCH_QUERY_CODEPOINTS = 128

/** Most Worker search results returned. */
export const MAX_WORKER_SEARCH_RESULTS = 30

/** Largest serialized Worker search payload, exact UTF-8 bytes (32 KiB). */
export const MAX_WORKER_SEARCH_RESULT_BYTES = 32 * 1024

/** Largest Worker Git result, exact UTF-8 bytes (64 KiB, no byte-cut). */
export const MAX_WORKER_GIT_RESULT_BYTES = 64 * 1024

/** Largest persisted Worker tool state, exact UTF-8 bytes (256 KiB). */
export const MAX_WORKER_TOOL_STATE_BYTES = 256 * 1024

/** Lazy approval expiry (15 minutes, no background jobs). */
export const APPROVAL_MAX_AGE_MS = 15 * 60 * 1000
