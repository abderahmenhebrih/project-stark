import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_MAX_AUDIO_BYTES, VOICE_SUPPORTED_MIME_TYPES } from '../../../../shared/voice/types'
import {
  appendTranscription,
  encodeAudioBase64,
  formatVoiceElapsed,
  mapMicrophoneErrorName,
  probeVoiceMimeType,
  voiceRecordingExhausted
} from './voice-recorder'

describe('voice recorder helpers', () => {
  it('probes MediaRecorder formats in preference order', () => {
    assert.equal(
      probeVoiceMimeType((mimeType) => mimeType === 'audio/webm'),
      'audio/webm'
    )
    assert.equal(
      probeVoiceMimeType(() => true),
      VOICE_SUPPORTED_MIME_TYPES[0]
    )
    assert.equal(probeVoiceMimeType(() => false), null)
    assert.equal(
      probeVoiceMimeType(() => {
        throw new Error('probe blew up')
      }),
      null
    )
  })

  it('enforces duration and byte bounds', () => {
    assert.equal(voiceRecordingExhausted(5 * 60 * 1000, 0), true)
    assert.equal(voiceRecordingExhausted(0, VOICE_MAX_AUDIO_BYTES), true)
    assert.equal(voiceRecordingExhausted(60 * 1000, 1024), false)
    assert.equal(VOICE_MAX_AUDIO_BYTES, 25 * 1024 * 1024)
  })

  it('formats elapsed recording time', () => {
    assert.equal(formatVoiceElapsed(0), '0:00')
    assert.equal(formatVoiceElapsed(65000), '1:05')
    assert.equal(formatVoiceElapsed(5 * 60 * 1000), '5:00')
  })

  it('appends transcription without replacing existing composer text', () => {
    const empty = appendTranscription('', 'hello stark', null)
    assert.equal(empty.text, 'hello stark')
    const spaced = appendTranscription('fix the navbar', 'with three links', null)
    assert.equal(spaced.text, 'fix the navbar with three links')
    const blank = appendTranscription('draft ', 'next words', null)
    assert.equal(blank.text, 'draft next words')
    const atCaret = appendTranscription('hello world', 'brave', { start: 6, end: 6 })
    assert.equal(atCaret.text, 'hello brave world')
    assert.equal(atCaret.caret, 'hello brave'.length)
    const untouched = appendTranscription('keep me', '   ', null)
    assert.equal(untouched.text, 'keep me')
  })

  it('maps native microphone failures to safe copy', () => {
    assert.equal(mapMicrophoneErrorName('NotAllowedError'), 'Microphone permission denied.')
    assert.equal(mapMicrophoneErrorName('SecurityError'), 'Microphone permission denied.')
    assert.equal(mapMicrophoneErrorName('NotFoundError'), 'No microphone was found.')
    assert.equal(mapMicrophoneErrorName('OverconstrainedError'), 'No microphone was found.')
    assert.equal(mapMicrophoneErrorName('AbortError'), 'Transcription failed.')
  })

  it('encodes audio bytes for the narrow channel', () => {
    const bytes = new Uint8Array([104, 105])
    assert.equal(encodeAudioBase64(bytes), 'aGk=')
    assert.equal(encodeAudioBase64(new Uint8Array(0)), '')
  })

  it('never auto-sends: insertion returns text for the composer only', () => {
    const merged = appendTranscription('existing draft', 'transcribed words', null)
    assert.ok(merged.text.includes('existing draft'))
    assert.ok(merged.text.includes('transcribed words'))
  })
})
