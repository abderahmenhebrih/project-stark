/**
 * Central limits for Stage 17 persistent Change Sets.
 * Single definitions — no layer duplicates these numbers.
 */

/** Most Change Sets returned by one recent-history load. */
export const MAX_RECENT_CHANGE_SETS = 20

/** Most existing transactions grouped into one set (matches the per-call import cap). */
export const MAX_GROUP_CHANGE_SET_FILES = 10
