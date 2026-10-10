/**
 * Central limits for chat-attachment workspace imports (Step 3).
 * Single definitions — no layer duplicates these numbers.
 */

/** Most attachment imports proposed in one Worker tool call (matches the per-message cap). */
export const MAX_ATTACHMENT_IMPORTS_PER_CALL = 10

/** SHA-256 of zero bytes: the reviewed "absent" checkpoint for binary ADDs. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
