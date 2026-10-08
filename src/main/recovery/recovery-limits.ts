/**
 * Central limits for Stage 21 Continuity Recovery.
 * Single definitions — no layer duplicates these numbers.
 */

/** Longest recovery provider ID, in Unicode code points (mirrors Heart). */
export const MAX_RECOVERY_PROVIDER_ID_CODEPOINTS = 100

/** Longest recovery model ID, in Unicode code points (mirrors Heart). */
export const MAX_RECOVERY_MODEL_ID_CODEPOINTS = 200

/** Max provider calls for one PRIMARY Ask (1) and one RECOVERY Ask (1). */
export const MAX_ASK_PRIMARY_CALLS = 1
export const MAX_ASK_RECOVERY_CALLS = 1
/** Absolute max provider calls across one Ask operation incl. recovery. */
export const MAX_ASK_TOTAL_CALLS = 2

/** Max provider calls for one PRIMARY Work (3) and one RECOVERY Work (3). */
export const MAX_WORK_PRIMARY_CALLS = 3
export const MAX_WORK_RECOVERY_CALLS = 3
/** Absolute max provider calls across one Work operation incl. recovery. */
export const MAX_WORK_TOTAL_CALLS = 6

/** Maximum automatic recovery hops per source request. Always 1. */
export const MAX_RECOVERY_HOPS = 1

/** Per provider call budget in milliseconds (60 seconds). */
export const RECOVERY_PROVIDER_CALL_TIMEOUT_MS = 60000

/** Per Work run budget in milliseconds (150 seconds). */
export const RECOVERY_WORK_RUN_TIMEOUT_MS = 150000
