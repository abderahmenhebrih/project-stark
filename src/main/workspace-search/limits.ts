/**
 * Central limits and policies for bounded workspace text search.
 *
 * Single definitions — no layer duplicates these numbers. Every budget
 * stops the search safely with truncated:true (bounded partial success),
 * never a throw, never a hang. Small justified variations from the spec
 * are not taken here: these ARE the spec values.
 */

/** Longest accepted query, counted in Unicode code points. */
export const MAX_SEARCH_QUERY_CODEPOINTS = 256

/** Most text candidates actually read during one search. */
export const MAX_SEARCH_FILES = 2000

/** Most matches returned over IPC during one search. */
export const MAX_SEARCH_RESULTS = 200

/** Most matches returned from any single file. */
export const MAX_MATCHES_PER_FILE = 20

/** Largest single file searched (1 MiB). Metadata checked before reading. */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024

/** Most file bytes read in total during one search (32 MiB). */
export const MAX_TOTAL_SEARCH_BYTES = 32 * 1024 * 1024

/** Longest line preview, in Unicode code points. */
export const MAX_PREVIEW_CHARACTERS = 240

/** Main-process elapsed-time budget per search (5 seconds). */
export const MAX_SEARCH_DURATION_MS = 5000

/**
 * Likely secret-bearing filenames excluded from AUTOMATIC scanning.
 *
 * Stage 6 permits explicit manual preview of files such as `.env` because
 * that is a direct user action and contents stay local. Search is different
 * because it automatically opens many files, so these are skipped by
 * default. They remain visible and manual-previewable in Explorer; their
 * contents are never sent or exposed anywhere by search.
 *
 * Centralized: no other module duplicates this policy.
 */
export const SENSITIVE_EXACT_NAMES: readonly string[] = ['.env', 'credentials.json', 'credentials.yml', 'credentials.yaml']

/** Prefix match (lowercased): `.env.local`, `.env.production`, … */
export const SENSITIVE_DOTENV_PREFIX = '.env.'

/** Lowercased extensions excluded as likely key material. */
export const SENSITIVE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx']
