/**
 * Central limits for local chat attachments (images + files).
 * Single definitions — no layer duplicates these numbers.
 */

/** Largest accepted attachment, measured in exact bytes (25 MiB). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Largest image kept as inline-previewable (10 MiB); bigger images store as files. */
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024

/** Most attachments linked to one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

/** Largest aggregate attachment bytes linked to one message (100 MiB). */
export const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024

/** Longest display filename, counted in Unicode code points. */
export const MAX_ATTACHMENT_NAME_CODEPOINTS = 120

/** Random ID bytes (hex-encoded to 32 lowercase characters). */
export const ATTACHMENT_ID_BYTES = 16
