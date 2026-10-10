import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { VOICE_MAX_AUDIO_BYTES } from '../../shared/voice/types'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import { ProviderTimeoutError } from '../ai/errors'
import {
  ProviderRegistry,
  type AiProviderAdapter,
  type ProviderTranscriptionRequest,
  type ProviderTranscriptionResult
} from '../ai/provider-adapter'
import {
  InvalidVoiceRequestError,
  UnsupportedVoiceFormatError,
  VoiceProviderUnavailableError,
  VoiceRecordingTooLargeError,
  VoiceTranscriptionFailedError,
  VoiceTranscriptionTimeoutError,
  toPublicVoiceError
} from './errors'
import { VoiceTranscriptionService } from './voice-transcription-service'

class FakeProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    return true
  }

  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake:${secret}`, 'utf8')
  }

  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false }
  }
}

class FakeTranscriber implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  script: (ProviderTranscriptionResult | Error)[] = [{ text: 'hello stark' }]
  calls: (ProviderTranscriptionRequest & { readonly apiKey: string })[] = []

  async listModels(): Promise<readonly []> {
    return []
  }

  async generateText(): Promise<{ text: string }> {
    throw new Error('transcription tests never use text chat')
  }

  async transcribeAudio(
    request: ProviderTranscriptionRequest & { readonly apiKey: string }
  ): Promise<ProviderTranscriptionResult> {
    this.calls.push(request)
    const next = this.script.shift()
    if (next === undefined) {
      throw new Error('transcription script exhausted (no retry expected)')
    }
    if (next instanceof Error) {
      throw next
    }
    return next
  }
}

function openHarness(options?: { withTranscriber?: boolean; credential?: boolean }): {
  db: DatabaseSync
  service: VoiceTranscriptionService
  adapter: FakeTranscriber
  storeRoot: string
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const registry = new ProviderRegistry()
  const adapter = new FakeTranscriber()
  if (options?.withTranscriber !== false) {
    registry.register(adapter)
  }
  const providerService = new AiProviderService(new AiProviderRepository(db), new FakeProtector(), registry)
  if (options?.credential !== false) {
    new AiProviderRepository(db).setEncryptedCredential('openai', Buffer.from('fake:sk-test', 'utf8'), 1)
  }
  const storeRoot = mkdtempSync(join(tmpdir(), 'stark-voice-'))
  return { db, service: new VoiceTranscriptionService({ providerService, registry }), adapter, storeRoot }
}

function closeHarness(h: { db: DatabaseSync; storeRoot: string }): void {
  h.db.close()
  rmSync(h.storeRoot, { recursive: true, force: true })
}

function audioBase64(bytes: number): string {
  return Buffer.alloc(bytes, 1).toString('base64')
}

describe('voice transcription service', () => {
  it('transcribes bounded audio into normalized text', async () => {
    const h = openHarness()
    try {
      const result = await h.service.transcribe({ audioBase64: audioBase64(64), mimeType: 'audio/webm;codecs=opus' })
      assert.equal(result.text, 'hello stark')
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(h.adapter.calls[0]?.model, 'whisper-1')
      // Renderer never chooses provider endpoints or secrets: the
      // request carries bytes plus MIME only.
      assert.deepEqual(Object.keys(h.adapter.calls[0] ?? {}).sort(), ['apiKey', 'audioBytes', 'mimeType', 'model'])
    } finally {
      closeHarness(h)
    }
  })

  it('rejects narrow-shape violations (no provider URL/model/secret/path authority)', async () => {
    const h = openHarness()
    try {
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm', providerUrl: 'https://evil.example/' }),
        InvalidVoiceRequestError
      )
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm', model: 'other' }),
        InvalidVoiceRequestError
      )
      await assert.rejects(h.service.transcribe({ audioBase64: '', mimeType: 'audio/webm' }), InvalidVoiceRequestError)
      await assert.rejects(h.service.transcribe({ mimeType: 'audio/webm' }), InvalidVoiceRequestError)
      assert.equal(h.adapter.calls.length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('rejects unsupported recording formats', async () => {
    const h = openHarness()
    try {
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/mp4' }),
        UnsupportedVoiceFormatError
      )
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'video/webm' }),
        UnsupportedVoiceFormatError
      )
      assert.equal(h.adapter.calls.length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('enforces the 25 MiB audio bound', async () => {
    const h = openHarness()
    try {
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(VOICE_MAX_AUDIO_BYTES + 1), mimeType: 'audio/webm' }),
        VoiceRecordingTooLargeError
      )
      assert.equal(h.adapter.calls.length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('fails closed without a transcription-capable adapter or credential', async () => {
    const noAdapter = openHarness({ withTranscriber: false })
    try {
      await assert.rejects(
        noAdapter.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm' }),
        VoiceProviderUnavailableError
      )
    } finally {
      closeHarness(noAdapter)
    }
    const noCredential = openHarness({ credential: false })
    try {
      await assert.rejects(
        noCredential.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm' }),
        VoiceProviderUnavailableError
      )
    } finally {
      closeHarness(noCredential)
    }
  })

  it('maps timeouts and failures to safe copy with zero retries', async () => {
    const h = openHarness()
    try {
      h.adapter.script = [new ProviderTimeoutError()]
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm' }),
        VoiceTranscriptionTimeoutError
      )
      assert.equal(h.adapter.calls.length, 1)
      h.adapter.script = [new Error('provider exploded')]
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm' }),
        VoiceTranscriptionFailedError
      )
      assert.equal(h.adapter.calls.length, 2)
      h.adapter.script = [{ text: '   ' }]
      await assert.rejects(
        h.service.transcribe({ audioBase64: audioBase64(16), mimeType: 'audio/webm' }),
        VoiceTranscriptionFailedError
      )
    } finally {
      closeHarness(h)
    }
  })

  it('never persists audio to the attachment store or disk', async () => {
    const h = openHarness()
    try {
      await h.service.transcribe({ audioBase64: audioBase64(128), mimeType: 'audio/webm' })
      const sessions = new CodingSessionRepository(h.db)
      const count: unknown = h.db.prepare('SELECT COUNT(*) AS n FROM chat_attachments').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
      void sessions
      assert.deepEqual(readdirSync(h.storeRoot), [])
    } finally {
      closeHarness(h)
    }
  })

  it('normalizes errors to the spec copy with no raw provider detail', () => {
    assert.equal(toPublicVoiceError(new VoiceProviderUnavailableError()).message, 'No speech-to-text provider is configured.')
    assert.equal(toPublicVoiceError(new VoiceTranscriptionTimeoutError()).message, 'Transcription timed out.')
    assert.equal(toPublicVoiceError(new VoiceRecordingTooLargeError()).message, 'Recording is too large.')
    assert.equal(toPublicVoiceError(new Error('sk-secret https://evil')).message, 'Transcription failed.')
    assert.ok(!toPublicVoiceError(new Error('sk-secret')).message.includes('sk-secret'))
  })
})
