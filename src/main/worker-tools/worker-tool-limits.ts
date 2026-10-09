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

/** Largest single proposed file inside change_propose, exact UTF-8 bytes (64 KiB, reuse Stage 16 bound). */
export const MAX_WORKER_PROPOSAL_FILE_BYTES = 64 * 1024

/** Most requested targets inside one change_propose invocation. */
export const MAX_WORKER_PROPOSAL_CHANGES = 5

/** Longest per-file proposal summary inside change_propose, Unicode code points. */
export const MAX_WORKER_PROPOSAL_FILE_SUMMARY_CODEPOINTS = 300

/** Largest combined proposed content inside one change_propose invocation, exact UTF-8 bytes (192 KiB). */
export const MAX_WORKER_PROPOSAL_TOTAL_BYTES = 192 * 1024

/** Lazy approval expiry (15 minutes, no background jobs). */
export const APPROVAL_MAX_AGE_MS = 15 * 60 * 1000

/** Largest serialized Worker runtime observation, exact UTF-8 bytes (64 KiB, newest logs preferred). */
export const MAX_WORKER_RUNTIME_OBSERVATION_BYTES = 64 * 1024

/** Single bounded hidden Preview load deadline, in milliseconds (one attempt, no retry). */
export const MAX_PREVIEW_INSPECTION_LOAD_MS = 10_000

/** Most rendered elements returned by one Preview inspection. */
export const MAX_PREVIEW_INSPECTION_ELEMENTS = 100

/** Largest Preview visible text, exact UTF-8 bytes (32 KiB, UTF-8-safe truncation). */
export const MAX_PREVIEW_VISIBLE_TEXT_BYTES = 32 * 1024

/** Longest per-element Preview text, Unicode code points. */
export const MAX_PREVIEW_ELEMENT_TEXT_CODEPOINTS = 300

/** Largest serialized Preview inspection result, exact UTF-8 bytes (64 KiB). */
export const MAX_PREVIEW_INSPECTION_RESULT_BYTES = 64 * 1024
