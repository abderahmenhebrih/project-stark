import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { CloudAccountRepository } from '../cloud-account/cloud-account-repository'
import { SessionProtector } from '../cloud-account/cloud-auth-session-store'
import { CloudAccountService } from '../cloud-account/cloud-account-service'
import { OAuthAttemptManager } from '../cloud-account/oauth-attempt-manager'
import type { CloudAuthAdapter, NormalizedCloudIdentity } from '../cloud-account/cloud-account-types'
import type { CredentialProtector } from '../ai/credential-protector'
import { createAccountBindings } from './account'

class FakeProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    return true
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake-enc:${Buffer.from(secret, 'utf8').toString('base64')}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    const text = ciphertext.toString('utf8')
    return { secret: Buffer.from(text.slice('fake-enc:'.length), 'base64').toString('utf8'), shouldReEncrypt: false }
  }
}

class FakeAdapter implements CloudAuthAdapter {
  isConfigured(): boolean {
    return true
  }
  async beginOAuth(): Promise<{ url: string }> {
    return { url: 'https://supabase.example/auth/v1/authorize' }
  }
  async exchangeCode(): Promise<never> {
    throw new Error('not used')
  }
  async restoreSession(): Promise<null> {
    return null
  }
  async signOut(): Promise<void> {}
  async upsertOwnProfile(_identity: NormalizedCloudIdentity): Promise<void> {
    void _identity
  }
}

function openService(): { db: DatabaseSync; service: CloudAccountService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const service = new CloudAccountService({
    repository: new CloudAccountRepository(db),
    sessionProtector: new SessionProtector(new FakeProtector()),
    authAdapter: new FakeAdapter(),
    attempts: new OAuthAttemptManager(() => 1000),
    browserOpener: () => Promise.resolve()
  })
  return { db, service }
}

describe('account IPC bindings', () => {
  it('exposes exactly four invoke channels and no OAuth completion channel', () => {
    const { db, service } = openService()
    try {
      const channels = createAccountBindings(service).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [
        IPC_CHANNELS.accountCancelSignIn,
        IPC_CHANNELS.accountGetStatus,
        IPC_CHANNELS.accountSignOut,
        IPC_CHANNELS.accountStartSignIn
      ])
      for (const channel of Object.values(IPC_CHANNELS)) {
        assert.ok(!channel.includes('complete-oauth'), 'no OAuth completion IPC may exist')
        assert.ok(!channel.includes('account:complete'), 'no OAuth completion IPC may exist')
      }
    } finally {
      db.close()
    }
  })

  it('start-sign-in accepts provider enums only — never URLs, codes, or sessions', async () => {
    const { db, service } = openService()
    try {
      const bindings = createAccountBindings(service)
      const start = bindings.find((binding) => binding.channel === IPC_CHANNELS.accountStartSignIn)
      assert.ok(start !== undefined)
      const invoke = (payload: unknown): Promise<unknown> => start.invoke(payload)
      await assert.rejects(() => invoke({ url: 'https://evil.example' }), /cloud-auth/)
      await assert.rejects(() => invoke({ provider: 'discord' }), /cloud-auth-invalid-provider/)
      await assert.rejects(() => invoke({ provider: 'google', code: 'x' }), /cloud-auth/)
    } finally {
      db.close()
    }
  })

  it('get-status/cancel/sign-out reject non-empty hostile payloads', async () => {
    const { db, service } = openService()
    try {
      const bindings = createAccountBindings(service)
      const byChannel = new Map(bindings.map((binding) => [binding.channel, binding]))
      const invoke = (channel: string, payload: unknown): Promise<unknown> => {
        const binding = byChannel.get(channel as (typeof byChannel extends Map<infer K, unknown> ? K : never))
        assert.ok(binding !== undefined)
        return binding.invoke(payload)
      }
      await assert.rejects(() => invoke(IPC_CHANNELS.accountGetStatus, { token: 'x' }), /cloud-auth/)
      await assert.rejects(() => invoke(IPC_CHANNELS.accountCancelSignIn, { code: 'x' }), /cloud-auth/)
      await assert.rejects(() => invoke(IPC_CHANNELS.accountSignOut, { session: 'x' }), /cloud-auth/)
    } finally {
      db.close()
    }
  })
})
