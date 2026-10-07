/**
 * Central limits for Stage 14 provider + completion behavior.
 * Single definitions — no layer duplicates these numbers.
 */

/** Model-list / connection-test network budget (15 seconds, one attempt). */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15000

/** Assistant generation network budget (60 seconds, one attempt). */
export const AI_GENERATE_TIMEOUT_MS = 60000

/** safeStorage operation budget (15 seconds). */
export const SAFE_STORAGE_TIMEOUT_MS = 15000

/** Largest accepted pasted API key, in UTF-8 bytes (16 KiB). */
export const MAX_API_KEY_BYTES = 16 * 1024

/** Most models surfaced from one discovery call. */
export const MAX_PROVIDER_MODELS = 500

/** Longest persisted model ID, in characters (1–128). */
export const MAX_MODEL_ID_CHARACTERS = 128

/** Bounded output budget requested from the Responses API. */
export const MAX_ASSISTANT_OUTPUT_TOKENS = 4096

/** Most session messages sent as generation context. */
export const MAX_AI_CONTEXT_MESSAGES = 40

/** Largest generation context, in UTF-8 bytes (256 KiB). */
export const MAX_AI_CONTEXT_BYTES = 256 * 1024

/**
 * Fixed Stage 14 developer instruction. Main-process-owned; the
 * renderer can never override it. It prevents false tool claims —
 * it is NOT the future Brain prompt.
 */
export const STAGE_14_FIXED_INSTRUCTIONS =
  'You are STARK, a coding assistant. Respond to the user\u2019s message. ' +
  'You do not currently have access to project files, terminal, Git, web browsing, or external tools. ' +
  'Do not claim that you inspected, executed, or modified anything.'
