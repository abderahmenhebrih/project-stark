/**
 * Central limits for image generation (Step 5). Single definitions —
 * shared capability constants mirror these numbers; the service
 * enforces them authoritatively.
 */

/** Most images per generation request (1..4). */
export const MAX_IMAGE_GENERATION_COUNT = 4

/** Largest single generated image, exact bytes (25 MiB). */
export const MAX_IMAGE_GENERATION_BYTES = 25 * 1024 * 1024

/** Hard per-operation provider budget, milliseconds (120 seconds, 0 retries). */
export const IMAGE_OPERATION_TIMEOUT_MS = 120 * 1000

/** Hard outer bound for one tool execution, milliseconds (180 seconds). */
export const IMAGE_TOOL_OUTER_TIMEOUT_MS = 180 * 1000

/** Maximum parallel provider calls inside one fan-out. */
export const MAX_IMAGE_FANOUT_PARALLEL = 2

/** Longest generation prompt, Unicode code points. */
export const MAX_IMAGE_PROMPT_CODEPOINTS = 4000
