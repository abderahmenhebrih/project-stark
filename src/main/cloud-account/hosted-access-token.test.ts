import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CloudAuthSignInRequiredError, CloudAuthUnavailableError } from './cloud-account-errors'
import type { CloudAccountRepository } from './cloud-account-repository'
import type { CloudAuthAdapter, CloudSessionEnvelope } from './cloud-account-types'
import { SessionProtector } from './cloud-auth-session-store'
import type { CredentialProtector } from '../ai/credential-protector'
import { getValidHostedAccessToken } from './hosted-access-token'

/**
 * Hosted access-token proof (no network, no Supabase, no keys).
 * Fake store/protector/adapter drive every branch: fresh tokens
 * return with zero restore traffic, expired tokens refresh exactly
 * once with atomic re-persistence, and every unusable state maps to
 * sign-in-required (storage loss stays fail-closed).
 */

class FakeProtector implements CredentialProtector {
  constructor(private readonly available = true) {}
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake:${secret}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false }
  }
}

function envelope(partial?: Partial<CloudSessionEnvelope>): CloudSessionEnvelope {
  return {
    accessToken: 'ACCESS-MARKER',
    refreshToken: 'REFRESH-MARKER',
    expiresAt: null,
    userId: 'user-1',
    ...partial
  }
}

function fakeRepository(account: boolean, session: CloudSessionEnvelope | null, saved?: { count: number }): CloudAccountRepository {
  return {
    findAccount: () =>
      account
        ? {
            cloudUserId: 'user-1',
            provider: 'google',
            email: null,
            displayName: null,
            avatarUrl: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        : undefined,
    findEncryptedSession: () =>
      session === null
        ? undefined
        : { encryptedSession: Buffer.from(`fake:${JSON.stringify(session)}`, 'utf8'), expiresAt: null },
    saveAccountAndSession: () => {
      if (saved !== undefined) {
        saved.count += 1
      }
    },
    clearAccountAndSession: () => undefined
  } as unknown as CloudAccountRepository
}

function fakeAdapter(configured = true, restored: CloudSessionEnvelope | null = null): CloudAuthAdapter & { restoreCalls: () => number } {
  let calls = 0
  const adapter: CloudAuthAdapter = {
    isConfigured: () => configured,
    beginOAuth: async () => ({ url: 'https://example.invalid' }),
    exchangeCode: async () => {
      throw new Error('unused')
    },
    restoreSession: async () => {
      calls += 1
      if (restored === null) {
        return null
      }
      return {
        identity: { cloudUserId: 'user-1', provider: 'google' as const, email: null, displayName: null, avatarUrl: null },
        session: restored
      }
    },
    signOut: async () => undefined,
    upsertOwnProfile: async () => undefined
  }
  return { ...adapter, restoreCalls: () => calls }
}

describe('hosted access token', () => {
  it('returns fresh tokens with zero restore traffic', async () => {
    const adapter = fakeAdapter(true)
    const token = await getValidHostedAccessToken({
      repository: fakeRepository(true, envelope()),
      protector: new SessionProtector(new FakeProtector()),
      adapter
    })
    assert.equal(token, 'ACCESS-MARKER')
    assert.equal(adapter.restoreCalls(), 0)
  })

  it('rejects unconfigured, signed-out, and sessionless states', async () => {
    const unconfigured = fakeAdapter(false)
    await assert.rejects(
      getValidHostedAccessToken({
        repository: fakeRepository(true, envelope()),
        protector: new SessionProtector(new FakeProtector()),
        adapter: unconfigured
      }),
      CloudAuthUnavailableError
    )
    for (const [account, session] of [[false, null], [true, null]] as const) {
      await assert.rejects(
        getValidHostedAccessToken({
          repository: fakeRepository(account, session),
          protector: new SessionProtector(new FakeProtector()),
          adapter: fakeAdapter(true)
        }),
        CloudAuthSignInRequiredError
      )
    }
  })

  it('refreshes once past expiry and re-persists atomically', async () => {
    const saved = { count: 0 }
    const adapter = fakeAdapter(true, envelope({ accessToken: 'ACCESS-ROTATED', expiresAt: 9_999_999_999_999 }))
    const token = await getValidHostedAccessToken({
      repository: fakeRepository(true, envelope({ expiresAt: 1000 }), saved),
      protector: new SessionProtector(new FakeProtector()),
      adapter,
      now: () => 5_000
    })
    assert.equal(token, 'ACCESS-ROTATED')
    assert.equal(adapter.restoreCalls(), 1)
    assert.equal(saved.count, 1)
  })

  it('maps revoked refresh and corrupt envelopes to sign-in-required', async () => {
    const revoked = fakeAdapter(true, null)
    await assert.rejects(
      getValidHostedAccessToken({
        repository: fakeRepository(true, envelope({ expiresAt: 1000 })),
        protector: new SessionProtector(new FakeProtector()),
        adapter: revoked,
        now: () => 5_000
      }),
      CloudAuthSignInRequiredError
    )
    const corruptRepository = {
      ...fakeRepository(true, envelope()),
      findEncryptedSession: () => ({ encryptedSession: Buffer.from('fake:not-json{{{', 'utf8'), expiresAt: null })
    } as unknown as CloudAccountRepository
    await assert.rejects(
      getValidHostedAccessToken({
        repository: corruptRepository,
        protector: new SessionProtector(new FakeProtector()),
        adapter: fakeAdapter(true)
      }),
      CloudAuthSignInRequiredError
    )
  })

  it('keeps secure-storage failures fail-closed', async () => {
    await assert.rejects(
      getValidHostedAccessToken({
        repository: fakeRepository(true, envelope()),
        protector: new SessionProtector(new FakeProtector(false)),
        adapter: fakeAdapter(true)
      }),
      (error: unknown) => error instanceof Error && error.name === 'CloudAuthSecureStorageUnavailableError'
    )
  })
})
