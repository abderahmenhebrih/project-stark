/**
 * Central limits for persistent change transactions.
 * Single definitions — services and repositories reference these,
 * never magic numbers.
 */

/** Stage 9 creates exactly one file change per transaction. */
export const MAX_FILES_PER_CHANGE_TRANSACTION = 1

/** Largest checkpoint/proposal payload persisted per file (1 MiB). */
export const MAX_CHANGE_TRANSACTION_FILE_BYTES = 1024 * 1024

/** Most recent transactions returned per workspace history query. */
export const MAX_RECENT_CHANGE_TRANSACTIONS = 20
