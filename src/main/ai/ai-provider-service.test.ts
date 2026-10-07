import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { ProviderCredentialMissingError, SecureStorageUnavailableError } from './errors'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import { ProviderInvalidCredentialError, ProviderRateLimitedError, ProviderTimeoutError, ProviderNetworkError } from './errors'
import { ProviderForbiddenError } from './errors'
import type { ProviderModel } from '../../shared/providers/types'

class FakeProtector implements CredentialProtector {
  available = true
  reEncrypt = false
  corruptNext = false
  decryptCalls = 0
  encryptCalls = 0

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async encrypt(secret: string): Promise<Buffer> {
    this.encryptCalls += 1
    if (!this.available) {
      throw new SecureStorageUnavailableError()
    }
    return Buffer.from(`fake:${secret}`, 'utf8')
  }

  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    this.decryptCalls += 1
    if (!this.available) {
      throw new SecureStorageUnavailableError()
    }
    if (this.corruptNext) {
      this.corruptNext = false
      return { secret: 'different-secret', shouldReEncrypt: false }
    }
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: this.reEncrypt }
  }
}

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  models: ProviderModel[] = [{ id: 'gpt-4o' }]
  listError: unknown = null
  generateError: unknown = null
  listCalls = 0
  seenApiKeys: string[] = []

  async listModels(apiKey: string): Promise<readonly ProviderModel[]> {
    this.listCalls += 1
    this.seenApiKeys.push(apiKey)
    if (this.listError !== null) {
      throw this.listError
    }
    return this.models
  }

  async generateText(request: ProviderGenerateRequest & { readonly apiKey: string }): Promise<ProviderGenerateResult> {
    this.seenApiKeys.push(request.apiKey)
    if (this.generateError !== null) {
      throw this.generateError
    }
    return { text: 'fake reply' }
  }
}

function openService(): {
  db: DatabaseSync
  service: AiProviderService
  protector: FakeProtector
  adapter: FakeAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const protector = new FakeProtector()
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const service = new AiProviderService(new AiProviderRepository(db), protector, registry)
  return { db, service, protector, adapter }
}

describe('AI provider service', () => {
  it('reports unconfigured state without touching secrets', async () => {
    const { db, service, protector } = openService()
    try {
      const state = await service.getState({ providerId: 'openai' })
      assert.equal(state.configured, false)
      assert.equal(state.selectedModel, null)
      assert.equal(state.secureStorageAvailable, true)
      assert.equal(state.displayName, 'OpenAI')
      assert.equal(protector.decryptCalls, 0)
      assert.ok(!JSON.stringify(state).includes('sk-'))
    } finally {
      db.close()
    }
  })

  it('rejects unknown providers and malformed shapes', async () => {
    const { db, service } = openService()
    try {
      const { InvalidProviderRequestError, toPublicProviderError } = await import('./errors')
      await assert.rejects(service.getState({ providerId: 'anthropic' }), /That AI provider is not available\./)
      // Malformed shapes throw typed errors that the IPC layer maps to
      // public copy; the service itself never renders UI strings here.
      await assert.rejects(service.getState({}), InvalidProviderRequestError)
      await assert.rejects(service.getState({ providerId: 'openai', extra: 1 }), InvalidProviderRequestError)
      assert.equal(
        toPublicProviderError('state', new InvalidProviderRequestError('provider request is invalid')).message,
        'We couldn’t load the AI provider settings.'
      )
    } finally {
      db.close()
    }
  })

  it('saves a trimmed key and reports configured', async () => {
    const { db, service } = openService()
    try {
      const state = await service.saveCredential({ providerId: 'openai', apiKey: '  sk-test-key  ' })
      assert.equal(state.configured, true)
      // State never carries the key back in any form.
      assert.ok(!JSON.stringify(state).includes('sk-test-key'))
    } finally {
      db.close()
    }
  })

  it('validates credential input strictly', async () => {
    const { db, service } = openService()
    try {
      for (const bad of [
        { providerId: 'openai', apiKey: '' },
        { providerId: 'openai', apiKey: '   ' },
        { providerId: 'openai', apiKey: 42 },
        { providerId: 'openai', apiKey: 'bad\0key' },
        { providerId: 'openai', apiKey: 'x'.repeat(16 * 1024 + 1) },
        { providerId: 'anthropic', apiKey: 'sk-x' },
        { providerId: 'openai' }
      ]) {
        await assert.rejects(service.saveCredential(bad), Error)
      }
      assert.equal((await service.getState({ providerId: 'openai' })).configured, false)
    } finally {
      db.close()
    }
  })

  it('fails closed when secure storage is unavailable', async () => {
    const { db, service, protector } = openService()
    try {
      protector.available = false
      await assert.rejects(saveAttempt(), /Secure credential storage is not available on this system\./)
      async function saveAttempt(): Promise<unknown> {
        return service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
      }
      assert.equal((await service.getState({ providerId: 'openai' })).secureStorageAvailable, false)
    } finally {
      db.close()
    }
  })

  it('clears the credential while keeping the selected model', async () => {
    const { db, service } = openService()
    try {
      await service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
      await service.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const cleared = await service.clearCredential({ providerId: 'openai' })
      assert.equal(cleared.configured, false)
      assert.equal(cleared.selectedModel, 'gpt-4o')
    } finally {
      db.close()
    }
  })

  it('persists and replaces the selected model', async () => {
    const { db, service } = openService()
    try {
      const first = await service.setModel({ providerId: 'openai', model: 'gpt-4o' })
      assert.equal(first.selectedModel, 'gpt-4o')
      const second = await service.setModel({ providerId: 'openai', model: 'o3-mini' })
      assert.equal(second.selectedModel, 'o3-mini')
    } finally {
      db.close()
    }
  })

  it('validates model IDs as safe identifiers', async () => {
    const { db, service } = openService()
    try {
      assert.equal((await service.setModel({ providerId: 'openai', model: 'a'.repeat(128) })).selectedModel?.length, 128)
      for (const bad of ['', 'x'.repeat(129), 'https://evil.example/model', 'has space', 'semi;colon', '../x']) {
        await assert.rejects(service.setModel({ providerId: 'openai', model: bad }), Error)
      }
    } finally {
      db.close()
    }
  })

  it('lists models through the stored credential', async () => {
    const { db, service, protector, adapter } = openService()
    try {
      adapter.models = [{ id: 'b-model' }, { id: 'a-model' }]
      await service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
      const before = protector.decryptCalls
      const models = await service.listModels({ providerId: 'openai' })
      assert.deepEqual(models, [{ id: 'b-model' }, { id: 'a-model' }])
      assert.equal(protector.decryptCalls, before + 1)
      assert.deepEqual(adapter.seenApiKeys, ['sk-x'])
    } finally {
      db.close()
    }
  })

  it('refuses model listing without a stored credential', async () => {
    const { db, service, protector } = openService()
    try {
      await assert.rejects(service.listModels({ providerId: 'openai' }), ProviderCredentialMissingError)
      assert.equal(protector.decryptCalls, 0)
    } finally {
      db.close()
    }
  })

  it('re-encrypts silently when rotation is signaled', async () => {
    const { db, service, protector } = openService()
    try {
      await service.saveCredential({ providerId: 'openai', apiKey: 'sk-rotate' })
      protector.reEncrypt = true
      const before = protector.encryptCalls
      await service.listModels({ providerId: 'openai' })
      assert.ok(protector.encryptCalls > before)
    } finally {
      db.close()
    }
  })

  it('tests connection as connected with models from one call', async () => {
    const { db, service, adapter } = openService()
    try {
      adapter.models = [{ id: 'gpt-4o' }]
      await service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
      const result = await service.testConnection({ providerId: 'openai' })
      assert.equal(result.status, 'connected')
      assert.deepEqual(result.models, [{ id: 'gpt-4o' }])
      assert.equal(adapter.listCalls, 1)
    } finally {
      db.close()
    }
  })

  it('maps connection failures to safe statuses', async () => {
    const cases: [unknown, string][] = [
      [new ProviderInvalidCredentialError(), 'invalid-credential'],
      [new ProviderRateLimitedError(), 'rate-limited'],
      [new ProviderTimeoutError(), 'timeout'],
      [new ProviderNetworkError(), 'network-error']
    ]
    for (const [failure, status] of cases) {
      const { db, service, adapter } = openService()
      try {
        await service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
        adapter.listError = failure
        const result = await service.testConnection({ providerId: 'openai' })
        assert.equal(result.status, status)
        assert.deepEqual(result.models, [])
      } finally {
        db.close()
      }
    }
  })

  it('throws (never misreports) on permission-denied connection tests', async () => {
    const { db, service, adapter } = openService()
    try {
      await service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
      adapter.listError = new ProviderForbiddenError()
      await assert.rejects(service.testConnection({ providerId: 'openai' }), (error: unknown) => {
        assert.ok(error instanceof ProviderForbiddenError)
        assert.ok(!error.message.includes('rejected'))
        assert.equal(error.message, 'The API key does not have permission for this request. Check the key’s project permissions and try again.')
        return true
      })
    } finally {
      db.close()
    }
  })

  it('verifies the stored key round-trips on save', async () => {
    const { db, service, protector } = openService()
    try {
      const state = await service.saveCredential({ providerId: 'openai', apiKey: 'sk-roundtrip' })
      assert.equal(state.configured, true)
      assert.ok(protector.decryptCalls >= 1, 'save must read back and decrypt what it stored')
    } finally {
      db.close()
    }
  })

  it('fails a save whose stored bytes do not decrypt to the key', async () => {
    const { db, service, protector } = openService()
    try {
      protector.corruptNext = true
      await assert.rejects(service.saveCredential({ providerId: 'openai', apiKey: 'sk-x' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'We couldn’t store this API key securely.')
        assert.ok(!error.message.includes('sk-x'))
        return true
      })
      // The unverifiable row is removed so a later save starts clean.
      assert.equal((await service.getState({ providerId: 'openai' })).configured, false)
    } finally {
      db.close()
    }
  })

  it('throws for connection tests without a credential', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.testConnection({ providerId: 'openai' }), ProviderCredentialMissingError)
    } finally {
      db.close()
    }
  })
})
