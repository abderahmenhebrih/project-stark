/**
 * Central limits for voice input (Step 4). Single definitions — the
 * shared contract mirrors these numbers for renderer UX, but the
 * main service enforces them authoritatively.
 */

/** Largest accepted recording, exact encoded bytes (25 MiB). */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024

/** Largest accepted base64 payload, exact characters (~33% over the byte bound). */
export const MAX_VOICE_AUDIO_BASE64_CHARS = 36 * 1024 * 1024

/** Hard provider transcription budget, milliseconds (60 seconds, 0 retries). */
export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 60 * 1000
