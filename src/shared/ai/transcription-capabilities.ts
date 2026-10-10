/**
 * Shared speech-to-text capability model (Step 4).
 *
 * Plain TypeScript only — no Node.js or DOM APIs. Transcription is a
 * dedicated audio→text transformation, never a normal Brain/Worker
 * text completion. Not every provider transcribes audio: only
 * configured providers with real transcription support may be
 * selected, and the renderer never chooses providers or endpoints.
 */

/** Transcription model used for the OpenAI provider (fixed, main-owned). */
export const TRANSCRIPTION_MODEL = 'whisper-1'

/** Audio MIME types the transcription path accepts (mirrors the recorder probe list). */
export const SUPPORTED_TRANSCRIPTION_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus'
]

/** Largest transcription audio payload, exact encoded bytes (25 MiB). */
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024

/** Longest transcription source audio, milliseconds (5 minutes). */
export const MAX_TRANSCRIPTION_AUDIO_DURATION_MS = 5 * 60 * 1000

/**
 * True when the provider offers real speech-to-text. Only OpenAI
 * (Whisper) is implemented — never fabricated for providers lacking
 * transcription APIs.
 */
export function providerSupportsSpeechToText(providerId: string): boolean {
  return providerId === 'openai'
}
