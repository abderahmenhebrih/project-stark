import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CloudAuthSignInRequiredError, CloudAuthUnavailableError } from '../cloud-account/cloud-account-errors'
import type { CloudAccountRepository } from '../cloud-account/cloud-account-repository'
import type { CloudAuthAdapter, CloudSessionEnvelope } from '../cloud-account/cloud-account-types'
import { SessionProtector } from '../cloud-account/cloud-auth-session-store'
import type { CredentialProtector } from '../ai/credential-protector'
import { StarkHostedSignInRequiredError, StarkHostedUnavailableError } from '../ai/errors'
import { createHostedSessionProvider } from './hosted-session'

/**
 * Hosted session bridge proof (no network, no Supabase, no keys).
 * Fake repository/protector/adapter drive the mapping: usable
 * sessions yield tokens, everything else maps to the two hosted AI
 * errors. Token material is only ever an inert test marker.
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

function fakeRepository(account: boolean, session: CloudSessionEnvelope | null): CloudAccountRepository {
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
    saveAccountAndSession: () => undefined,
    clearAccountAndSession: () => undefined
  } as unknown as CloudAccountRepository
}

function fakeAdapter(configured = true, restored: CloudSessionEnvelope | null = null): CloudAuthAdapter & { restoreCalls: number } {
  const state = {
    restoreCalls: 0,
    async restoreSession(): Promise<{ identity: { cloudUserId: string; provider: 'google'; email: null; displayName: null; avatarUrl: null }; session: CloudSessionEnvelope } | null> {
      state.restoreCalls += 1
      if (restored === null) {
        return null
      }
      return {
        identity: { cloudUserId: 'user-1', provider: 'google' as const, email: null, displayName: null, avatarUrl: null },
        session: restored
      }
    }
  }
  return {
    isConfigured: () => configured,
    beginOAuth: async () => ({ url: 'https://example.invalid' }),
    exchangeCode: async () => {
      throw new Error('unused')
    },
    restoreSession: state.restoreSession,
    signOut: async () => undefined,
    upsertOwnProfile: async () => undefined,
    get restoreCalls(): number {
      return state.restoreCalls
    }
  } as unknown as CloudAuthAdapter & { restoreCalls: number }
}

describe('hosted session bridge', () => {
  it('returns the stored token with zero restore traffic when fresh', async () => {
    const adapter = fakeAdapter(true)
    const provider = createHostedSessionProvider({
      repository: fakeRepository(true, envelope()),
      protector: new SessionProtector(new FakeProtector()),
      adapter
    })
    assert.equal(await provider.getAccessToken(), 'ACCESS-MARKER')
    assert.equal(adapter.restoreCalls, 0)
  })

  it('maps signed-out and unconfigured states to hosted errors', async () => {
    const signedOut = createHostedSessionProvider({
      repository: fakeRepository(false, null),
      protector: new SessionProtector(new FakeProtector()),
      adapter: fakeAdapter(true)
    })
    await assert.rejects(signedOut.getAccessToken(), StarkHostedSignInRequiredError)
    const unconfigured = createHostedSessionProvider({
      repository: fakeRepository(true, envelope()),
      protector: new SessionProtector(new FakeProtector()),
      adapter: fakeAdapter(false)
    })
    await assert.rejects(unconfigured.getAccessToken(), StarkHostedUnavailableError)
  })

  it('refreshes once past expiry and persists the rotated envelope', async () => {
    let saved = 0
    const repository = fakeRepository(true, envelope({ expiresAt: 1000 }))
    const saving = {
      ...repository,
      saveAccountAndSession: () => {
        saved += 1
      }
    } as unknown as CloudAccountRepository
    const adapter = fakeAdapter(true, envelope({ accessToken: 'ACCESS-ROTATED', expiresAt: 9_999_999_999_999 }))
    const provider = createHostedSessionProvider({
      repository: saving,
      protector: new SessionProtector(new FakeProtector()),
      adapter,
      now: () => 5_000
    })
    assert.equal(await provider.getAccessToken(), 'ACCESS-ROTATED')
    assert.equal(adapter.restoreCalls, 1)
    assert.equal(saved, 1)
  })

  it('maps failed refresh to sign-in-required and storage loss to unavailable', async () => {
    const revoked = createHostedSessionProvider({
      repository: fakeRepository(true, envelope({ expiresAt: 1000 })),
      protector: new SessionProtector(new FakeProtector()),
      adapter: fakeAdapter(true, null),
      now: () => 5_000
    })
    await assert.rejects(revoked.getAccessToken(), StarkHostedSignInRequiredError)
    const noStorage = createHostedSessionProvider({
      repository: fakeRepository(true, envelope()),
      protector: new SessionProtector(new FakeProtector(false)),
      adapter: fakeAdapter(true)
    })
    await assert.rejects(noStorage.getAccessToken(), StarkHostedUnavailableError)
  })

  it('resolves the function URL from public config only', async () => {
    const { hostedFunctionUrl } = await import('./hosted-session')
    assert.equal(hostedFunctionUrl({} as NodeJS.ProcessEnv), null)
    assert.equal(
      hostedFunctionUrl({ SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_ANON_KEY: 'k' } as NodeJS.ProcessEnv),
      'https://abc.supabase.co/functions/v1/stark-infer'
    )
  })

  it('never exposes cloud error classes to AI callers', async () => {
    const provider = createHostedSessionProvider({
      repository: fakeRepository(false, null),
      protector: new SessionProtector(new FakeProtector()),
      adapter: fakeAdapter(true)
    })
    try {
      await provider.getAccessToken()
      assert.fail('must throw')
    } catch (error) {
      assert.ok(!(error instanceof CloudAuthSignInRequiredError), 'cloud errors must be mapped')
      assert.ok(!(error instanceof CloudAuthUnavailableError), 'cloud errors must be mapped')
      assert.ok(error instanceof StarkHostedSignInRequiredError)
    }
  })
})
