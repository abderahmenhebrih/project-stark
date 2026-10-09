/**
 * Central limits for Stage 29 cloud-account behavior.
 * Single definitions — no layer duplicates these numbers.
 */

/** One bounded OAuth attempt lifetime (5 minutes). No polling, no retry. */
export const MAX_AUTH_ATTEMPT_MS = 5 * 60 * 1000

/** Largest accepted deep-link callback URL, in characters. */
export const MAX_AUTH_CALLBACK_URL_CHARS = 4096

/** Largest accepted single callback parameter value, in characters. */
export const MAX_AUTH_CALLBACK_PARAM_CHARS = 4096

/** Longest normalized cloud user id, in code points. */
export const MAX_CLOUD_USER_ID_CODEPOINTS = 128

/** Longest normalized account email, in code points. */
export const MAX_CLOUD_EMAIL_CODEPOINTS = 320

/** Longest normalized display name, in code points. */
export const MAX_CLOUD_DISPLAY_NAME_CODEPOINTS = 120

/** Longest normalized avatar URL, in code points. */
export const MAX_CLOUD_AVATAR_URL_CODEPOINTS = 2048

/** Largest accepted token string inside the session envelope, in chars. */
export const MAX_CLOUD_TOKEN_CHARS = 8192

/** Exact STARK auth deep-link callback (scheme/host/path). */
export const STARK_AUTH_SCHEME = 'stark'
export const STARK_AUTH_HOST = 'auth'
export const STARK_AUTH_PATH = '/callback'
export const STARK_AUTH_REDIRECT_URI = 'stark://auth/callback'
