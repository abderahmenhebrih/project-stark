/**
 * Central limits for the Stage 25 Worker terminal_execute tool.
 * Single definitions — no layer duplicates these numbers.
 */

/** Hard wall-clock budget for one approved command, in milliseconds (60 seconds, one attempt). */
export const MAX_WORKER_COMMAND_RUNTIME_MS = 60_000

/** Largest combined captured stdout + stderr, exact raw bytes (64 KiB). */
export const MAX_WORKER_COMMAND_OUTPUT_BYTES = 64 * 1024

/** Most argv entries per command. */
export const MAX_WORKER_COMMAND_ARGS = 32

/** Largest serialized program + argv, exact UTF-8 bytes (12 KiB, no truncation). */
export const MAX_WORKER_COMMAND_ARGUMENT_BYTES = 12 * 1024

/** Longest bare executable name, Unicode code points. */
export const MAX_WORKER_COMMAND_PROGRAM_CODEPOINTS = 128

/** Longest single argv entry, Unicode code points. */
export const MAX_WORKER_COMMAND_ARG_CODEPOINTS = 2048

/** Largest PATH searched for bare-executable resolution, exact bytes (32 KiB). */
export const MAX_EXECUTABLE_PATH_BYTES = 32 * 1024

/** Most PATH entries consulted during resolution. */
export const MAX_EXECUTABLE_PATH_ENTRIES = 128

/** Bounded cleanup budget for terminating one spawned process, in milliseconds (5 seconds). */
export const MAX_COMMAND_CLEANUP_MS = 5_000
