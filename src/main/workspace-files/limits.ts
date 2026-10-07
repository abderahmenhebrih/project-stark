/**
 * Central limits and policies for read-only workspace inspection.
 * Single definitions — no layer duplicates these numbers.
 */

/** Largest file the text preview will read (1 MiB). */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024

/**
 * Largest UTF-8 payload the stale-safe writer accepts (1 MiB).
 * Separate constant from the read limit by design — no magic numbers
 * at write call sites — even though both are currently 1 MiB.
 */
export const MAX_WRITABLE_TEXT_FILE_BYTES = 1024 * 1024

/** Largest directory listing returned over IPC. */
export const MAX_DIRECTORY_ENTRIES = 500

/** Longest accepted relative-path request string. */
export const MAX_REQUEST_PATH_LENGTH = 4096

/**
 * Generated/cache directory names excluded from default listings.
 * Exact directory-name matches only — dotfiles in general stay visible,
 * and files are never filtered. No custom ignore support yet.
 */
export const IGNORED_DIRECTORY_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache'
]
