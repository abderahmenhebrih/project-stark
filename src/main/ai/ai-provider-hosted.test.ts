import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import {
  InvalidProviderRequestError,
  ProviderModelUnavailableError,
  StarkHostedSignInRequiredError,
  StarkHostedUnavailableError,
  UnknownProviderError
} from './errors'
import type { AiProviderAdapter, HostedSessionProvider } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'

/**
 * Hosted assignment proof (no network, no Supabase, no keys).
 * The `stark` branch resolves allowlisted builtin ids through the
 * injected session source; the OpenAI BYOK path is byte-identical.
 */

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

class StarkFakeAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'builtin:gpt-5.6-luna' }]
  }
  async generateText(): Promise<{ text: string }> {
    return { text: 'unused' }
  }
}

class OpenAiFakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }
  async generateText(): Promise<{ text: string }> {
    return { text: 'unused' }
  }
}

function openService(session: HostedSessionProvider | undefined): {
  db: DatabaseSync
  service: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const registry = new ProviderRegistry()
  registry.register(new OpenAiFakeAdapter())
  registry.register(new StarkFakeAdapter())
  const service = new AiProviderService(new AiProviderRepository(db), new FakeProtector(), registry, {
    ...(session === undefined ? {} : { hostedSessionProvider: session })
  })
  return { db, service }
}

function signedIn(): HostedSessionProvider {
  return {
    getAccessToken: async (): Promise<string> => 'ACCESS-MARKER'
  }
}

describe('hosted explicit assignment', () => {
  it('resolves allowlisted builtin ids to the stark adapter with a session token', async () => {
    const { db, service } = openService(signedIn())
    try {
      const resolved = await service.resolveExplicitAssignment('stark', 'builtin:gpt-5.6-luna')
      assert.equal(resolved.adapter.id, 'stark')
      assert.equal(resolved.apiKey, 'ACCESS-MARKER')
      assert.equal(resolved.model, 'builtin:gpt-5.6-luna')
      const dashed = await service.resolveExplicitAssignment('stark', 'builtin:gpt-5-6-luna')
      assert.equal(dashed.model, 'builtin:gpt-5-6-luna')
    } finally {
      db.close()
    }
  })

  it('rejects unknown builtin ids and malformed models before any token use', async () => {
    let calls = 0
    const counting: HostedSessionProvider = {
      getAccessToken: async (): Promise<string> => {
        calls += 1
        return 'ACCESS-MARKER'
      }
    }
    const { db, service } = openService(counting)
    try {
      await assert.rejects(service.resolveExplicitAssignment('stark', 'builtin:evil'), ProviderModelUnavailableError)
      await assert.rejects(service.resolveExplicitAssignment('stark', ''), InvalidProviderRequestError)
      assert.equal(calls, 0)
    } finally {
      db.close()
    }
  })

  it('maps signed-out sessions to sign-in-required', async () => {
    const { db, service } = openService({
      getAccessToken: async (): Promise<string> => {
        throw new StarkHostedSignInRequiredError()
      }
    })
    try {
      await assert.rejects(
        service.resolveExplicitAssignment('stark', 'builtin:gpt-5.6-luna'),
        StarkHostedSignInRequiredError
      )
    } finally {
      db.close()
    }
  })

  it('fails closed without a session source and for unknown providers', async () => {
    const { db, service } = openService(undefined)
    try {
      await assert.rejects(
        service.resolveExplicitAssignment('stark', 'builtin:gpt-5.6-luna'),
        StarkHostedUnavailableError
      )
      await assert.rejects(service.resolveExplicitAssignment('nope', 'm'), UnknownProviderError)
    } finally {
      db.close()
    }
  })

  it('leaves the OpenAI BYOK path byte-identical', async () => {
    const { db, service } = openService(signedIn())
    try {
      await service.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      const resolved = await service.resolveExplicitAssignment('openai', 'gpt-4o')
      assert.equal(resolved.adapter.id, 'openai')
      assert.equal(resolved.apiKey, 'sk-test')
      assert.equal(resolved.model, 'gpt-4o')
    } finally {
      db.close()
    }
  })
})
