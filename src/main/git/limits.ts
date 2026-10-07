/**
 * Central limits for Stage 12 read-only Git integration.
 * Single definitions — no layer duplicates these numbers.
 */

import type { GitDiffRequest, GitDiffResult, GitFileStatus, GitWorkspaceState } from '../../shared/git/types'

export type { GitDiffRequest, GitDiffResult, GitFileStatus, GitWorkspaceState }

/** Per-command wall-clock budget (5 seconds). No retries, no polling. */
export const GIT_COMMAND_TIMEOUT_MS = 5000

/** Largest Git status payload consumed before terminating the command (2 MiB). */
export const MAX_GIT_STATUS_OUTPUT_BYTES = 2 * 1024 * 1024

/** Largest Git diff payload consumed before terminating the command (2 MiB). */
export const MAX_GIT_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024

/** Most status entries surfaced per status call. */
export const MAX_GIT_FILES = 5000

/** Longest validated repo-relative diff path, in Unicode code points. */
export const MAX_GIT_RELATIVE_PATH_CODEPOINTS = 4096
