import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeVoiceError } from './voice-error'

describe('voice error boundary', () => {
  it('recognizes the spec transcription copy', () => {
    assert.equal(normalizeVoiceError(new Error('Microphone permission denied.')).kind, 'permission-denied')
    assert.equal(normalizeVoiceError(new Error('No microphone was found.')).kind, 'no-microphone')
    assert.equal(normalizeVoiceError(new Error('Recording is too long.')).kind, 'too-long')
    assert.equal(normalizeVoiceError(new Error('Recording is too large.')).kind, 'too-large')
    assert.equal(normalizeVoiceError(new Error('No speech-to-text provider is configured.')).kind, 'no-provider')
    assert.equal(normalizeVoiceError(new Error('Transcription timed out.')).kind, 'timeout')
    assert.equal(normalizeVoiceError(new Error('Transcription failed.')).kind, 'failed')
  })

  it('collapses unknown and raw failures to safe copy', () => {
    assert.equal(normalizeVoiceError(new Error('stark:voice:transcribe boom')).message, 'Transcription failed.')
    assert.equal(normalizeVoiceError(new Error('sk-secret ...stack...')).message, 'Transcription failed.')
    assert.ok(!normalizeVoiceError(new Error('sk-secret')).message.includes('sk-secret'))
    assert.equal(normalizeVoiceError(undefined).message, 'Transcription failed.')
  })
})
