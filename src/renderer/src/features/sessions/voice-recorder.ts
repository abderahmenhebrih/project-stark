import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_DURATION_MS,
  VOICE_SUPPORTED_MIME_TYPES
} from '../../../../shared/voice/types'

export type VoiceRecorderPhase = 'idle' | 'recording' | 'transcribing'

/**
 * Picks the first MediaRecorder MIME type the runtime supports,
 * probing in preference order. Returns null when the runtime can
 * record none of them — the caller then refuses with safe copy.
 * Never hardcodes a type the runtime cannot record.
 */
export function probeVoiceMimeType(isTypeSupported: (mimeType: string) => boolean): string | null {
  for (const mimeType of VOICE_SUPPORTED_MIME_TYPES) {
    try {
      if (isTypeSupported(mimeType)) {
        return mimeType
      }
    } catch {
      // A throwing probe counts as unsupported; try the next type.
    }
  }
  return null
}

/** True when recording must auto-stop: duration or byte bound reached. */
export function voiceRecordingExhausted(elapsedMs: number, bytesTotal: number): boolean {
  return elapsedMs >= VOICE_MAX_DURATION_MS || bytesTotal >= VOICE_MAX_AUDIO_BYTES
}

/** Elapsed-time display for the recording state ("M:SS"). */
export function formatVoiceElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes)}:${seconds < 10 ? '0' : ''}${String(seconds)}`
}

/**
 * Inserts transcription text into the composer without silently
 * replacing existing content. Text lands at the cursor when a valid
 * caret is supplied, otherwise appended at the end with appropriate
 * spacing. Returns the merged text plus the caret for the insertion
 * end. The caller sends nothing automatically — the user edits and
 * sends normally.
 */
export function appendTranscription(
  current: string,
  insertion: string,
  caret: { readonly start: number; readonly end: number } | null
): { readonly text: string; readonly caret: number } {
  const clean = insertion.trim()
  if (clean === '') {
    return { text: current, caret: caret === null ? current.length : caret.start }
  }
  if (caret === null || caret.start < 0 || caret.end < caret.start || caret.start > current.length || caret.end > current.length) {
    const spacer = current === '' || /\s$/.test(current) ? '' : ' '
    return { text: `${current}${spacer}${clean}`, caret: current.length + spacer.length + clean.length }
  }
  const before = current.slice(0, caret.start)
  const after = current.slice(caret.end)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = after === '' || /^\s/.test(after) ? '' : ' '
  const text = `${before}${lead}${clean}${trail}${after}`
  return { text, caret: before.length + lead.length + clean.length }
}

/**
 * Maps a native getUserMedia failure name to safe display copy.
 * Permission denial and missing hardware stay distinct; everything
 * else collapses to the generic failure.
 */
export function mapMicrophoneErrorName(name: string): string {
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission denied.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return 'No microphone was found.'
  }
  return 'Transcription failed.'
}

/** Encodes raw audio bytes for the narrow transcription channel. */
export function encodeAudioBase64(bytes: Uint8Array): string {
  const CHUNK = 8192
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}
