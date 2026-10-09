/**
 * Central limits for Stage 26 managed project runtimes.
 * Program/argv bounds reuse the Stage 25 terminal limits exactly —
 * this module only adds runtime-specific numbers.
 */

/** Most active (starting/running) runtimes per workspace. */
export const MAX_ACTIVE_RUNTIMES_PER_WORKSPACE = 1

/** Hard lifetime of one runtime session, in milliseconds (30 minutes, no extension). */
export const MAX_RUNTIME_SESSION_MS = 30 * 60 * 1000

/** Largest combined persisted/displayed rolling log tail, exact UTF-8 bytes (128 KiB). */
export const MAX_RUNTIME_LOG_TAIL_BYTES = 128 * 1024

/** Smallest preview port the Worker may request. */
export const MIN_RUNTIME_PORT = 1024

/** Largest preview port the Worker may request. */
export const MAX_RUNTIME_PORT = 65535

/** Bounded wait for one exact runtime tree to exit after signalling, in milliseconds (5 seconds). */
export const MAX_RUNTIME_STOP_WAIT_MS = 5000

/** Bounded global deadline for stopping all live runtimes at app shutdown, in milliseconds. */
export const MAX_RUNTIME_SHUTDOWN_MS = 15_000

/** Most runtimes returned by one recent-history load. */
export const MAX_RECENT_RUNTIMES = 10

/** Minimum coalescing interval for persisted log-tail writes, in milliseconds. */
export const MIN_RUNTIME_LOG_FLUSH_MS = 500
