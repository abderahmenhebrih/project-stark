import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runMigrations, migrations } from '../database/migrations/index'
import type { CredentialProtector } from '../ai/credential-protector'
import type { CloudAccountStatus } from '../../shared/cloud-account/types'
import { CloudAuthExchangeFailedError } from './cloud-account-errors'
import { STARK_AUTH_REDIRECT_URI } from './cloud-account-limits'
import { CloudAccountRepository } from './cloud-account-repository'
import { SessionProtector } from './cloud-auth-session-store'
import { CloudAccountService } from './cloud-account-service'
import { OAuthAttemptManager } from './oauth-attempt-manager'
import {
  buildSupabaseAuthOptions,
  SupabaseAuthAdapter,
  type MemoryPkceStorage,
  type SupabaseAuthClientOptions,
  type SupabasePublicConfig
} from './supabase-auth-adapter'

const VALID_CONFIG: SupabasePublicConfig = { url: 'https://abc.supabase.co', anonKey: 'public-anon-key' }

interface CapturedFactory {
  configs: SupabasePublicConfig[]
  options: SupabaseAuthClientOptions[]
  signInCalls: { provider: unknown; options: unknown }[]
  exchangeCalls: string[]
  verifierSeenAtExchange: (string | null)[]
  beginUrl: string
}

function capturingFactory(captured: CapturedFactory): (config: SupabasePublicConfig, options: SupabaseAuthClientOptions) => SupabaseClient {
  const fake = {
    auth: {
      signInWithOAuth: async (input: { provider: unknown; options?: { redirectTo?: unknown; skipBrowserRedirect?: unknown } }): Promise<unknown> => {
        captured.signInCalls.push({ provider: input.provider, options: input.options })
        // The fake behaves like the real PKCE SDK: it mints the
        // verifier into the SAME storage context the exchange reads.
        captured.options[0]?.storage.setItem('pkce-verifier', 'verifier-123')
        return { data: { url: captured.beginUrl }, error: null }
      },
      exchangeCodeForSession: async (code: string): Promise<unknown> => {
        captured.exchangeCalls.push(code)
        captured.verifierSeenAtExchange.push(captured.options[0]?.storage.getItem('pkce-verifier') ?? null)
        return {
          data: {
            session: { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_at: null, user: { id: 'user-123' } },
            user: { id: 'user-123', email: 'user@example.com', user_metadata: { full_name: 'QA User', avatar_url: 'https://example.com/a.png' } }
          },
          error: null
        }
      },
      setSession: async (): Promise<unknown> => ({ data: { session: null, user: null }, error: null }),
      signOut: async (): Promise<unknown> => ({ error: null })
    },
    from: () => ({ upsert: async (): Promise<unknown> => ({ error: null }) })
  };
  return ((config: SupabasePublicConfig, options: SupabaseAuthClientOptions): SupabaseClient => {
    captured.configs.push(config)
    captured.options.push(options)
    return fake as unknown as SupabaseClient
  })
}

function capture(): CapturedFactory {
  return {
    configs: [],
    options: [],
    signInCalls: [],
    exchangeCalls: [],
    verifierSeenAtExchange: [],
    beginUrl: 'https://abc.supabase.co/auth/v1/authorize?provider=google&redirect_to=stark%3A%2F%2Fauth%2Fcallback&code_challenge=abc&code_challenge_method=s256'
  }
}

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

function openService(captured: CapturedFactory): { db: DatabaseSync; service: CloudAccountService; opened: string[] } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const opened: string[] = []
  const service = new CloudAccountService({
    repository: new CloudAccountRepository(db),
    sessionProtector: new SessionProtector(new FakeProtector()),
    authAdapter: new SupabaseAuthAdapter(VALID_CONFIG, capturingFactory(captured)),
    attempts: new OAuthAttemptManager(() => 1_000_000),
    browserOpener: (url: string) => {
      opened.push(url)
      return Promise.resolve()
    },
    now: () => 1_000_000
  })
  return { db, service, opened }
}

describe('PKCE client with explicit deep-link redirect', () => {
  it('pins PKCE with a main-owned memory store and no background session handling', () => {
    const storage: MemoryPkceStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    }
    assert.deepEqual(
      { ...buildSupabaseAuthOptions(storage), storage: 'present' },
      { flowType: 'pkce', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storage: 'present' }
    )
    const captured = capture()
    const adapter = new SupabaseAuthAdapter(VALID_CONFIG, capturingFactory(captured))
    assert.equal(adapter.isConfigured(), true)
    assert.equal(captured.configs.length, 1)
    assert.equal(captured.options.length, 1)
    assert.equal(captured.options[0]?.flowType, 'pkce')
    assert.equal(captured.options[0]?.persistSession, false)
    assert.equal(captured.options[0]?.autoRefreshToken, false)
    assert.equal(captured.options[0]?.detectSessionInUrl, false)
    assert.ok(captured.options[0]?.storage !== undefined, 'verifier storage must be main-owned memory')
  })

  it('null config stays unconfigured without touching any factory', () => {
    let calls = 0
    const adapter = new SupabaseAuthAdapter(null, () => {
      calls += 1
      throw new Error('must not be called')
    })
    assert.equal(adapter.isConfigured(), false)
    assert.equal(calls, 0)
  })

  it('beginOAuth sends the exact deep-link redirect, never the Site URL', async () => {
    const captured = capture()
    const adapter = new SupabaseAuthAdapter(VALID_CONFIG, capturingFactory(captured))
    const outcome = await adapter.beginOAuth('google')
    assert.equal(captured.signInCalls.length, 1)
    const sent = captured.signInCalls[0]?.options as Record<string, unknown>
    // The desktop flow must never depend on the Supabase Site URL
    // (e.g. http://localhost:3000): the redirect is always explicit.
    assert.equal(sent['redirectTo'], STARK_AUTH_REDIRECT_URI)
    assert.equal(sent['redirectTo'], 'stark://auth/callback')
    assert.equal(sent['skipBrowserRedirect'], true)
    assert.equal(outcome.url, captured.beginUrl)
  })

  it('rejects generated URLs without a PKCE challenge instead of entering implicit flow', async () => {
    for (const badUrl of [
      'https://abc.supabase.co/auth/v1/authorize?provider=google',
      'http://abc.supabase.co/auth/v1/authorize?provider=google&code_challenge=x',
      'https://abc.supabase.co/other?code_challenge=x',
      ''
    ]) {
      const captured = capture()
      captured.beginUrl = badUrl
      const adapter = new SupabaseAuthAdapter(VALID_CONFIG, capturingFactory(captured))
      await assert.rejects(adapter.beginOAuth('github'), /cloud-auth-exchange-failed/)
    }
  })

  it('adapter source derives nothing from renderer or window location', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'main', 'cloud-account', 'supabase-auth-adapter.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    for (const forbidden of ['window.location', 'document.location', 'Site URL', 'localhost:3000', "flowType: 'implicit'"]) {
      assert.ok(!code.includes(forbidden), `adapter must not contain ${forbidden}`)
    }
    assert.ok(code.includes("flowType: 'pkce'"), 'adapter must pin PKCE')
  })
})

describe('PKCE callback handling', () => {
  it('exchanges a valid code exactly once with the same storage context', async () => {
    const captured = capture()
    const { db, service } = openService(captured)
    try {
      await service.startSignIn('google')
      const status = await service.handleAuthCallback('stark://auth/callback?code=pkce-code-1')
      assert.equal(status.state, 'signed_in')
      assert.deepEqual(captured.exchangeCalls, ['pkce-code-1'])
      assert.deepEqual(captured.verifierSeenAtExchange, ['verifier-123'])
      // Replay of the consumed code fails closed without a second exchange.
      await assert.rejects(service.handleAuthCallback('stark://auth/callback?code=pkce-code-1'), /cloud-auth-callback-invalid/)
      assert.deepEqual(captured.exchangeCalls, ['pkce-code-1'])
    } finally {
      db.close()
    }
  })

  it('rejects implicit callbacks without importing tokens', async () => {
    const captured = capture()
    const { db, service } = openService(captured)
    try {
      await service.startSignIn('github')
      for (const implicit of [
        'stark://auth/callback#access_token=IMPLICIT',
        'stark://auth/callback?code=abc#access_token=IMPLICIT',
        'stark://auth/callback#refresh_token=IMPLICIT'
      ]) {
        await assert.rejects(service.handleAuthCallback(implicit), /cloud-auth-callback-unsupported/)
      }
      assert.deepEqual(captured.exchangeCalls, [], 'no exchange may run for implicit residue')
      const status: CloudAccountStatus = service.getStatus()
      assert.ok(!JSON.stringify(status).includes('IMPLICIT'), 'fragment tokens must never enter state')
    } finally {
      db.close()
    }
  })

  it('successful exchange signs in without touching entitlements', async () => {
    const captured = capture()
    const { db, service } = openService(captured)
    try {
      await service.startSignIn('google')
      const status = await service.handleAuthCallback('stark://auth/callback?code=pkce-code-9')
      assert.equal(status.state, 'signed_in')
      if (status.state === 'signed_in') {
        assert.equal(status.account.provider, 'google')
        assert.equal(status.account.email, 'user@example.com')
        assert.ok(!('plan' in status.account), 'auth identity carries no entitlement')
      }
    } finally {
      db.close()
    }
  })

  it('sign out still clears the session and preserves local data', async () => {
    const captured = capture()
    const { db, service } = openService(captured)
    try {
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('/proj/a', 'a', 1, 1)")
      await service.startSignIn('google')
      await service.handleAuthCallback('stark://auth/callback?code=pkce-code-2')
      assert.equal(service.getStatus().state, 'signed_in')
      const after = await service.signOut()
      assert.equal(after.state, 'signed_out')
      const row = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as unknown as Record<string, unknown>
      assert.equal(row['n'], 1)
    } finally {
      db.close()
    }
  })
})

describe('provider attribution without silent defaults', () => {
  function adapterWithUser(user: unknown): SupabaseAuthAdapter {
    const fake = {
      auth: {
        exchangeCodeForSession: async (): Promise<unknown> => ({
          data: {
            session: { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_at: null, user: { id: 'user-123' } },
            user
          },
          error: null
        }),
        setSession: async (): Promise<unknown> => ({
          data: {
            session: { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_at: null, user: { id: 'user-123' } },
            user
          },
          error: null
        }),
        signOut: async (): Promise<unknown> => ({ error: null })
      },
      from: () => ({ upsert: async (): Promise<unknown> => ({ error: null }) })
    }
    return new SupabaseAuthAdapter(VALID_CONFIG, () => fake as unknown as SupabaseClient)
  }

  const envelope = { accessToken: 'ACCESS', refreshToken: 'REFRESH', expiresAt: null, userId: 'user-123' }

  it('explicit attempt context decides github without metadata', async () => {
    const adapter = adapterWithUser({ id: 'user-123' })
    const result = await adapter.exchangeCode('code-1', 'github')
    assert.equal(result.identity.provider, 'github')
  })

  it('explicit attempt context decides google without metadata', async () => {
    const adapter = adapterWithUser({ id: 'user-123' })
    const result = await adapter.exchangeCode('code-1', 'google')
    assert.equal(result.identity.provider, 'google')
  })

  it('server app_metadata decides when no explicit context exists', async () => {
    const adapter = adapterWithUser({ id: 'user-123', app_metadata: { provider: 'github' } })
    const result = await adapter.exchangeCode('code-1')
    assert.equal(result.identity.provider, 'github')
  })

  it('fails closed with neither context nor server metadata (never a silent default)', async () => {
    const adapter = adapterWithUser({ id: 'user-123' })
    await assert.rejects(adapter.exchangeCode('code-1'), CloudAuthExchangeFailedError)
  })

  it('rejects tampered server metadata providers', async () => {
    const adapter = adapterWithUser({ id: 'user-123', app_metadata: { provider: 'evil' } })
    await assert.rejects(adapter.exchangeCode('code-1'), CloudAuthExchangeFailedError)
    const displayNameSpoof = adapterWithUser({ id: 'user-123', app_metadata: { provider: 'google', full_name: 'x' } })
    const result = await displayNameSpoof.exchangeCode('code-1', 'github')
    assert.equal(result.identity.provider, 'github', 'explicit context beats metadata')
  })

  it('restoreSession resolves provider the same way or returns null', async () => {
    const explicit = adapterWithUser({ id: 'user-123' })
    const byContext = await explicit.restoreSession(envelope, 'github')
    assert.equal(byContext?.identity.provider, 'github')
    const byMetadata = await adapterWithUser({ id: 'user-123', app_metadata: { provider: 'github' } }).restoreSession(envelope)
    assert.equal(byMetadata?.identity.provider, 'github')
    const unresolvable = await adapterWithUser({ id: 'user-123' }).restoreSession(envelope)
    assert.equal(unresolvable, null)
  })
})
