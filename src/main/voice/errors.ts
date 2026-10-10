/**
 * Voice transcription domain errors (Step 4).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain provider payloads, stack traces,
 * audio bytes, IPC channel names, or key material.
 */

export class VoiceTranscriptionError extends Error {
  override readonly name: string = 'VoiceTranscriptionError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Transcription request payload failed runtime validation. */
export class InvalidVoiceRequestError extends VoiceTranscriptionError {
  override readonly name = 'InvalidVoiceRequestError'

  constructor() {
    super('That voice request is not valid.')
  }
}

/** The recording MIME type is not one STARK can transcribe. */
export class UnsupportedVoiceFormatError extends VoiceTranscriptionError {
  override readonly name = 'UnsupportedVoiceFormatError'

  constructor() {
    super('That recording format can’t be transcribed.')
  }
}

/** The recording exceeds the duration or byte bound. */
export class VoiceRecordingTooLargeError extends VoiceTranscriptionError {
  override readonly name = 'VoiceRecordingTooLargeError'

  constructor() {
    super('Recording is too large.')
  }
}

/** No transcription-capable provider is configured. */
export class VoiceProviderUnavailableError extends VoiceTranscriptionError {
  override readonly name = 'VoiceProviderUnavailableError'

  constructor() {
    super('No speech-to-text provider is configured.')
  }
}

/** The transcription request timed out (single attempt, no retry). */
export class VoiceTranscriptionTimeoutError extends VoiceTranscriptionError {
  override readonly name = 'VoiceTranscriptionTimeoutError'

  constructor(options?: { cause?: unknown }) {
    super('Transcription timed out.', options)
  }
}

/** The transcription request failed without a more specific cause. */
export class VoiceTranscriptionFailedError extends VoiceTranscriptionError {
  override readonly name = 'VoiceTranscriptionFailedError'

  constructor(options?: { cause?: unknown }) {
    super('Transcription failed.', options)
  }
}

/**
 * Maps any voice-layer failure to a renderer-safe Error carrying
 * displayable copy only. Unknown failures collapse to the generic
 * copy — never raw provider errors.
 */
export function toPublicVoiceError(error: unknown): Error {
  if (
    error instanceof InvalidVoiceRequestError ||
    error instanceof UnsupportedVoiceFormatError ||
    error instanceof VoiceRecordingTooLargeError ||
    error instanceof VoiceProviderUnavailableError ||
    error instanceof VoiceTranscriptionTimeoutError ||
    error instanceof VoiceTranscriptionFailedError
  ) {
    return new Error(error.message)
  }
  if (error instanceof VoiceTranscriptionError) {
    return new Error('Transcription failed.')
  }
  return new Error('Transcription failed.')
}
