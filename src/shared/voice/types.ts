/**
 * Shared voice-input contract (Step 4).
 *
 * Plain TypeScript only — no Node.js or DOM APIs — so it stays
 * importable from the main process, the preload bridge, and the
 * renderer. Bounds are defined ONCE here; the main service enforces
 * them authoritatively and the renderer mirrors them for UX only.
 */

/** Largest accepted recording, measured in exact encoded bytes (25 MiB). */
export const VOICE_MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Hard maximum recording duration in milliseconds (5 minutes). */
export const VOICE_MAX_DURATION_MS = 5 * 60 * 1000

/** Recommended initial UX recording budget (120 seconds). */
export const VOICE_RECOMMENDED_DURATION_MS = 120 * 1000

/** Hard provider transcription budget in milliseconds (60 seconds, 0 retries). */
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 60 * 1000

/**
 * MediaRecorder MIME types probed in preference order. The renderer
 * picks the FIRST type the runtime reports via
 * `MediaRecorder.isTypeSupported()` — never a hardcoded type the
 * runtime cannot record.
 */
export const VOICE_SUPPORTED_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus'
]

/** Narrow transcription request: encoded audio only. No URLs, no paths, no provider choice. */
export interface VoiceTranscribeRequest {
  readonly audioBase64: string
  readonly mimeType: string
}

/** Normalized transcription result: text plus safe optional metadata. Never raw provider output. */
export interface VoiceTranscribeResult {
  readonly text: string
  readonly detectedLanguage?: string
}

/** Voice slice of the preload bridge (`window.stark.voice`). */
export interface VoiceApi {
  transcribe: (request: VoiceTranscribeRequest) => Promise<VoiceTranscribeResult>
}
