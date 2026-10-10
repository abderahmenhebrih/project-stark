import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { createVoiceBindings } from '../ipc/voice'
import { toPublicVoiceError, VoiceTranscriptionFailedError } from './errors'

describe('voice transcription IPC', () => {
  it('exposes exactly one narrow transcription channel', () => {
    const calls: unknown[] = []
    const service = { transcribe: async (payload: unknown): Promise<{ text: string }> => {
      calls.push(payload)
      return { text: 'hi' }
    } }
    const bindings = createVoiceBindings(service as never)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0]?.channel, IPC_CHANNELS.voiceTranscribe)
    assert.equal(IPC_CHANNELS.voiceTranscribe, 'stark:voice:transcribe')
  })

  it('forwards bytes plus MIME only and normalizes the result', async () => {
    let seen: unknown = null
    const service = { transcribe: async (payload: unknown): Promise<{ text: string }> => {
      seen = payload
      return { text: 'hello', detectedLanguage: 'en' } as never
    } }
    const bindings = createVoiceBindings(service as never)
    const result = (await bindings[0]?.invoke({ audioBase64: 'aGk=', mimeType: 'audio/webm' }, undefined as never)) as {
      text: string
    }
    // Normalized text only — never raw provider metadata.
    assert.deepEqual(result, { text: 'hello' })
    assert.deepEqual(seen, { audioBase64: 'aGk=', mimeType: 'audio/webm' })
  })

  it('maps failures to safe copy with no raw detail', async () => {
    const service = { transcribe: async (): Promise<{ text: string }> => {
      throw new VoiceTranscriptionFailedError({ cause: new Error('sk-secret') })
    } }
    const bindings = createVoiceBindings(service as never)
    await assert.rejects(bindings[0]?.invoke({ audioBase64: 'aGk=', mimeType: 'audio/webm' }, undefined as never), /Transcription failed\./)
    assert.equal(toPublicVoiceError(new Error('stark:voice:transcribe boom')).message, 'Transcription failed.')
  })

  it('is registered behind the trusted-sender gate', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const index = readFileSync(join(process.cwd(), 'src', 'main', 'ipc', 'index.ts'), 'utf8')
    assert.ok(index.includes('createVoiceBindings'), 'voice bindings are registered')
    assert.ok(index.includes('handleSecureIpc'), 'all bindings sit behind the trust gate')
    const preload = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
    assert.ok(preload.includes('createVoiceApi()'), 'preload exposes the narrow voice API')
    assert.ok(!preload.includes('ipcRenderer.invoke(channel'), 'preload never invokes variable channels')
  })
})
