/**
 * Main-owned voice transcription service (Step 4).
 *
 * Owns provider selection, credential access, the bounded API
 * request, timeouts, and normalization. The renderer supplies ONLY
 * encoded audio bytes plus the probed MIME type through one narrow
 * IPC channel — never provider URLs, models, credentials, or
 * filesystem paths.
 *
 * Privacy: audio exists only long enough to transcribe. STARK never
 * persists recordings to the attachment store or to disk; bytes are
 * dropped as soon as the provider answers (or fails).
 */

import {
  SUPPORTED_TRANSCRIPTION_MIME_TYPES,
  TRANSCRIPTION_MODEL,
  providerSupportsSpeechToText
} from '../../shared/ai/transcription-capabilities'
import { VOICE_MAX_AUDIO_BYTES } from '../../shared/voice/types'
import type { AiProviderService } from '../ai/ai-provider-service'
import { ProviderTimeoutError } from '../ai/errors'
import type { ProviderRegistry } from '../ai/provider-adapter'
import { MAX_VOICE_AUDIO_BASE64_CHARS } from './limits'
import {
  InvalidVoiceRequestError,
  UnsupportedVoiceFormatError,
  VoiceProviderUnavailableError,
  VoiceRecordingTooLargeError,
  VoiceTranscriptionError,
  VoiceTranscriptionFailedError,
  VoiceTranscriptionTimeoutError
} from './errors'

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

function decodeBase64Audio(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value.replace(/\s+/g, ''))
  } catch {
    throw new InvalidVoiceRequestError()
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff
  }
  return bytes
}

export interface VoiceTranscriptionDeps {
  readonly providerService: AiProviderService
  readonly registry: ProviderRegistry
}

export class VoiceTranscriptionService {
  constructor(private readonly deps: VoiceTranscriptionDeps) {}

  /**
   * Transcribes one bounded recording into composer-ready text. The
   * result carries normalized text only — never raw provider output.
   * Audio bytes are never persisted, attached, or written to disk.
   */
  async transcribe(payload: unknown): Promise<{ readonly text: string }> {
    if (!hasStrictShape(payload, ['audioBase64', 'mimeType'])) {
      throw new InvalidVoiceRequestError()
    }
    const record = payload as Record<string, unknown>
    const audioBase64 = record['audioBase64']
    const mimeType = record['mimeType']
    if (typeof audioBase64 !== 'string' || audioBase64 === '') {
      throw new InvalidVoiceRequestError()
    }
    if (typeof mimeType !== 'string' || !SUPPORTED_TRANSCRIPTION_MIME_TYPES.includes(mimeType)) {
      throw new UnsupportedVoiceFormatError()
    }
    if (audioBase64.length > MAX_VOICE_AUDIO_BASE64_CHARS) {
      throw new VoiceRecordingTooLargeError()
    }
    const audioBytes = decodeBase64Audio(audioBase64)
    if (audioBytes.length === 0) {
      throw new InvalidVoiceRequestError()
    }
    if (audioBytes.length > VOICE_MAX_AUDIO_BYTES) {
      throw new VoiceRecordingTooLargeError()
    }
    // Dedicated modality routing: transcription-capable providers
    // only (currently OpenAI). Never the normal text-chat path, never
    // a renderer-chosen provider or endpoint.
    const providerId = 'openai' as const
    if (!providerSupportsSpeechToText(providerId)) {
      throw new VoiceProviderUnavailableError()
    }
    const adapter = this.deps.registry.get(providerId)
    if (adapter === undefined || typeof adapter.transcribeAudio !== 'function') {
      throw new VoiceProviderUnavailableError()
    }
    let apiKey: string
    try {
      apiKey = await this.deps.providerService.decryptCredentialForUse(providerId)
    } catch {
      throw new VoiceProviderUnavailableError()
    }
    try {
      const transcribe = adapter.transcribeAudio.bind(adapter)
      const result = await transcribe({
        apiKey,
        model: TRANSCRIPTION_MODEL,
        audioBytes,
        mimeType
      })
      const text = result.text.trim()
      if (text === '') {
        throw new VoiceTranscriptionFailedError()
      }
      return { text }
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) {
        throw error
      }
      if (error instanceof ProviderTimeoutError) {
        throw new VoiceTranscriptionTimeoutError({ cause: error })
      }
      throw new VoiceTranscriptionFailedError({ cause: error })
    } finally {
      // Drop audio + key references: transcription inputs are never
      // retained past the single provider attempt.
      void apiKey
      audioBytes.fill(0)
    }
  }
}
