import { TextEncoder } from 'node:util'
import type { AiProviderState, ProviderId, ProviderModel } from '../../shared/providers/types'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import {
  InvalidProviderRequestError,
  ProviderCredentialMissingError,
  ProviderInvalidCredentialError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  SecureStorageUnavailableError,
  UnknownProviderError
} from './errors'
import { MAX_API_KEY_BYTES, MAX_MODEL_ID_CHARACTERS } from './limits'
import { zeroBuffer, type CredentialProtector } from './credential-protector'
import { ProviderRegistry } from './provider-adapter'

const encoder = new TextEncoder()

/** Safe model-ID syntax: provider identifiers only. No URLs, no whitespace. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:+-]+$/

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

function validateApiKey(apiKey: unknown): string {
  if (typeof apiKey !== 'string') {
    throw new InvalidProviderRequestError('API key must be text')
  }
  const trimmed = apiKey.trim()
  if (trimmed === '') {
    throw new InvalidProviderRequestError('API key must not be empty')
  }
  // NUL byte written as an escape on purpose: no raw control bytes in source.
  if (trimmed.includes('\0')) {
    throw new InvalidProviderRequestError('API key is invalid')
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      throw new InvalidProviderRequestError('API key is invalid')
    }
  }
  if (encoder.encode(trimmed).byteLength > MAX_API_KEY_BYTES) {
    throw new InvalidProviderRequestError('API key is too large')
  }
  return trimmed
}

function validateModelId(model: unknown): string {
  if (typeof model !== 'string' || model.length < 1 || model.length > MAX_MODEL_ID_CHARACTERS) {
    throw new InvalidProviderRequestError('model reference is invalid')
  }
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new InvalidProviderRequestError('model reference is invalid')
  }
  return model
}

export interface AiProviderServiceOptions {
  /** Clock override for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
}

/**
 * AI provider domain service (Stage 14). Owns known-provider
 * validation, storage capability checks, credential save/clear,
 * configured status, model persistence, model listing, connection
 * testing, and decrypt-only-when-needed. No SQL (repository), no
 * Electron (protector abstraction), no SDK details (registry).
 */
export class AiProviderService {
  private readonly now: () => number

  constructor(
    private readonly providers: AiProviderRepository,
    private readonly protector: CredentialProtector,
    private readonly registry: ProviderRegistry,
    options?: AiProviderServiceOptions
  ) {
    this.now = options?.now ?? Date.now
  }

  requireProvider(providerId: unknown): ProviderId {
    if (typeof providerId !== 'string' || !this.registry.isKnown(providerId)) {
      throw new UnknownProviderError()
    }
    return providerId
  }

  validateOnlyProvider(payload: unknown): ProviderId {
    if (!hasStrictShape(payload, ['providerId'])) {
      throw new InvalidProviderRequestError('provider request is invalid')
    }
    const providerId = (payload as Record<string, unknown>)['providerId']
    if (typeof providerId !== 'string') {
      throw new InvalidProviderRequestError('provider request is invalid')
    }
    return this.requireProvider(providerId)
  }

  /** Public provider state. Never contains secrets of any form. */
  async getState(payload: unknown): Promise<{
    readonly providerId: ProviderId
    readonly displayName: string
    readonly secureStorageAvailable: boolean
    readonly configured: boolean
    readonly selectedModel: string | null
  }> {
    const providerId = this.validateOnlyProvider(payload)
    const adapter = this.registry.get(providerId)
    if (adapter === undefined) {
      throw new UnknownProviderError()
    }
    const stored = this.providers.findConfig(providerId)
    return {
      providerId,
      displayName: adapter.displayName,
      secureStorageAvailable: await this.protector.isAvailable(),
      configured: this.providers.findEncryptedCredential(providerId) !== undefined,
      selectedModel: stored?.selectedModel ?? null
    }
  }

  async saveCredential(payload: unknown): Promise<AiProviderState> {
    if (!hasStrictShape(payload, ['providerId', 'apiKey'])) {
      throw new InvalidProviderRequestError('credential request is invalid')
    }
    const record = payload as Record<string, unknown>
    const providerId = this.requireProvider(record['providerId'])
    const apiKey = validateApiKey(record['apiKey'])
    if (!(await this.protector.isAvailable())) {
      throw new SecureStorageUnavailableError()
    }
    const ciphertext = await this.protector.encrypt(apiKey)
    try {
      this.providers.setEncryptedCredential(providerId, ciphertext, this.now())
    } finally {
      zeroBuffer(ciphertext)
    }
    return this.getState({ providerId })
  }

  async clearCredential(payload: unknown): Promise<AiProviderState> {
    const providerId = this.validateOnlyProvider(payload)
    // Clearing needs no crypto: stored bytes are simply dropped, so a
    // system that lost secure storage can still recover this way.
    this.providers.clearEncryptedCredential(providerId)
    return this.getState({ providerId })
  }

  /**
   * Decrypts the stored credential for one immediate provider call.
   * Handles key rotation (re-encrypt + replace) silently. Callers must
   * drop the returned string reference immediately after use — JS
   * strings cannot be zeroed, so minimal lifetime is the mitigation.
   */
  async decryptCredentialForUse(providerId: ProviderId): Promise<string> {
    const ciphertext = this.providers.findEncryptedCredential(providerId)
    if (ciphertext === undefined) {
      throw new ProviderCredentialMissingError()
    }
    try {
      const { secret, shouldReEncrypt } = await this.protector.decrypt(ciphertext)
      if (shouldReEncrypt) {
        const fresh = await this.protector.encrypt(secret)
        try {
          this.providers.setEncryptedCredential(providerId, fresh, this.now())
        } finally {
          zeroBuffer(fresh)
        }
      }
      return secret
    } finally {
      zeroBuffer(ciphertext)
    }
  }

  async listModels(payload: unknown): Promise<readonly ProviderModel[]> {
    const providerId = this.validateOnlyProvider(payload)
    const adapter = this.registry.get(providerId)
    if (adapter === undefined) {
      throw new UnknownProviderError()
    }
    const apiKey = await this.decryptCredentialForUse(providerId)
    try {
      return await adapter.listModels(apiKey)
    } finally {
      // Drop the only reference: JS strings cannot be zeroed, so the
      // shortest possible lifetime is the documented mitigation.
      void apiKey
    }
  }

  /**
   * Tests the connection with ONE bounded Models API call using the
   * stored credential — never a billable generation. Provider-side
   * failures return a safe status (never throw, never raw bodies);
   * local problems (missing credential, unavailable storage) throw
   * for the IPC layer to map. On success the same single response
   * also supplies the model list.
   */
  async testConnection(payload: unknown): Promise<{ readonly status: 'connected' | 'invalid-credential' | 'rate-limited' | 'network-error' | 'timeout'; readonly models: readonly ProviderModel[] }> {
    const providerId = this.validateOnlyProvider(payload)
    const adapter = this.registry.get(providerId)
    if (adapter === undefined) {
      throw new UnknownProviderError()
    }
    const apiKey = await this.decryptCredentialForUse(providerId)
    try {
      const models = await adapter.listModels(apiKey)
      return { status: 'connected', models }
    } catch (error) {
      if (error instanceof ProviderInvalidCredentialError) {
        return { status: 'invalid-credential', models: [] }
      }
      if (error instanceof ProviderRateLimitedError) {
        return { status: 'rate-limited', models: [] }
      }
      if (error instanceof ProviderTimeoutError) {
        return { status: 'timeout', models: [] }
      }
      return { status: 'network-error', models: [] }
    } finally {
      // Drop the only reference: JS strings cannot be zeroed, so the
      // shortest possible lifetime is the documented mitigation.
      void apiKey
    }
  }

  async setModel(payload: unknown): Promise<AiProviderState> {
    if (!hasStrictShape(payload, ['providerId', 'model'])) {
      throw new InvalidProviderRequestError('model request is invalid')
    }
    const record = payload as Record<string, unknown>
    const providerId = this.requireProvider(record['providerId'])
    const model = validateModelId(record['model'])
    this.providers.setSelectedModel(providerId, model, this.now())
    return this.getState({ providerId })
  }
}
