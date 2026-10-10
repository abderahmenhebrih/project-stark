/**
 * Renderer-side error boundary for voice transcription (Step 4).
 *
 * Same principle as the provider boundary: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process voice mapping
 * are recognized; anything unrecognized collapses to safe copy.
 */

export type VoiceErrorKind =
  | 'permission-denied'
  | 'no-microphone'
  | 'too-long'
  | 'too-large'
  | 'no-provider'
  | 'timeout'
  | 'failed'

export interface NormalizedVoiceError {
  readonly kind: VoiceErrorKind
  readonly message: string
}

/** Stable main-process public messages for voice operations. */
const MAIN_PERMISSION_DENIED = 'Microphone permission denied.'
const MAIN_NO_MICROPHONE = 'No microphone was found.'
const MAIN_TOO_LONG = 'Recording is too long.'
const MAIN_TOO_LARGE = 'Recording is too large.'
const MAIN_NO_PROVIDER = 'No speech-to-text provider is configured.'
const MAIN_TIMEOUT = 'Transcription timed out.'
const MAIN_FAILED = 'Transcription failed.'
const MAIN_UNSUPPORTED_FORMAT = 'That recording format can’t be transcribed.'

export const VOICE_PERMISSION_DENIED_MESSAGE = MAIN_PERMISSION_DENIED
export const VOICE_NO_MICROPHONE_MESSAGE = MAIN_NO_MICROPHONE
export const VOICE_TOO_LONG_MESSAGE = MAIN_TOO_LONG
export const VOICE_TOO_LARGE_MESSAGE = MAIN_TOO_LARGE
export const VOICE_NO_PROVIDER_MESSAGE = MAIN_NO_PROVIDER
export const VOICE_TIMEOUT_MESSAGE = MAIN_TIMEOUT
export const VOICE_FAILED_MESSAGE = MAIN_FAILED

const KNOWN_OUTCOMES: readonly { readonly kind: VoiceErrorKind; readonly mainMessage: string }[] = [
  { kind: 'permission-denied', mainMessage: MAIN_PERMISSION_DENIED },
  { kind: 'no-microphone', mainMessage: MAIN_NO_MICROPHONE },
  { kind: 'too-long', mainMessage: MAIN_TOO_LONG },
  { kind: 'too-large', mainMessage: MAIN_TOO_LARGE },
  { kind: 'no-provider', mainMessage: MAIN_NO_PROVIDER },
  { kind: 'timeout', mainMessage: MAIN_TIMEOUT },
  { kind: 'failed', mainMessage: MAIN_FAILED },
  { kind: 'failed', mainMessage: MAIN_UNSUPPORTED_FORMAT }
]

/**
 * Normalizes any thrown voice failure to canonical display-safe
 * copy, falling back to the caller-supplied message.
 */
export function normalizeVoiceError(error: unknown, fallback: string = VOICE_FAILED_MESSAGE): NormalizedVoiceError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.mainMessage)) {
        return { kind: outcome.kind, message: outcome.mainMessage }
      }
    }
  }
  return { kind: 'failed', message: fallback }
}
