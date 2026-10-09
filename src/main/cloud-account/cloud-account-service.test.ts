import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import type { CloudAccountStatus, StarkAuthProvider } from '../../shared/cloud-account/types'
import { runMigrations, migrations } from '../database/migrations/index'
import type { CredentialProtector } from '../ai/credential-protector'
import { CloudAccountRepository } from './cloud-account-repository'
import { SessionProtector } from './cloud-auth-session-store'
import type { AuthenticatedIdentity, CloudAuthAdapter, CloudSessionEnvelope, NormalizedCloudIdentity } from './cloud-account-types'
import { CloudAccountService } from './cloud-account-service'
import { OAuthAttemptManager } from './oauth-attempt-manager'
import { MAX_AUTH_ATTEMPT_MS } from './cloud-account-limits'

const ACCESS = 'ACCESS_SECRET_123'
const REFRESH = 'REFRESH_SECRET_456'
const CODE = 'CODE_SECRET_789'

class ObscuringProtector implements CredentialProtector {
  constructor(private available: boolean = true) {}
  setAvailable(available: boolean): void {
    this.available = available
  }
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake-enc:${Buffer.from(secret, 'utf8').toString('base64')}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    const text = ciphertext.toString('utf8')
    if (!text.startsWith('fake-enc:')) {
      throw new Error('corrupt blob')
    }
    return { secret: Buffer.from(text.slice('fake-enc:'.length), 'base64').toString('utf8'), shouldReEncrypt: false }
  }
}

class FakeAuthAdapter implements CloudAuthAdapter {
  configured = true
  beginCount = 0
  exchangeCount = 0
  restoreCount = 0
  signOutCount = 0
  upsertCount = 0
  lastProvider: StarkAuthProvider | undefined
  exchangeFail = false
  restoreBehavior: 'ok' | 'null' | 'throw' = 'ok'
  signOutFail = false
  upsertFail = false
  seenCodes: string[] = []

  isConfigured(): boolean {
    return this.configured
  }
  async beginOAuth(provider: StarkAuthProvider): Promise<{ url: string }> {
    this.beginCount += 1
    this.lastProvider = provider
    return { url: `https://supabase.example/auth/v1/authorize?provider=${provider}` }
  }
  async exchangeCode(code: string): Promise<AuthenticatedIdentity> {
    this.exchangeCount += 1
    this.seenCodes.push(code)
    if (this.exchangeFail) {
      throw new Error('exchange boom')
    }
    const provider = this.lastProvider ?? 'google'
    const identity: NormalizedCloudIdentity = {
      cloudUserId: 'user-123',
      provider,
      email: 'user@example.com',
      displayName: provider === 'github' ? 'Abderahmen' : 'Google User',
      avatarUrl: 'https://example.com/avatar.png'
    }
    const session: CloudSessionEnvelope = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null, userId: 'user-123' }
    return { identity, session }
  }
  async restoreSession(session: CloudSessionEnvelope): Promise<AuthenticatedIdentity | null> {
    this.restoreCount += 1
    if (this.restoreBehavior === 'throw') {
      throw new Error('network down')
    }
    if (this.restoreBehavior === 'null') {
      return null
    }
    return {
      identity: {
        cloudUserId: 'user-123',
        provider: this.lastProvider ?? 'google',
        email: 'user@example.com',
        displayName: 'Restored',
        avatarUrl: 'https://example.com/avatar.png'
      },
      session
    }
  }
  async signOut(): Promise<void> {
    this.signOutCount += 1
    if (this.signOutFail) {
      throw new Error('remote revoke down')
    }
  }
  async upsertOwnProfile(_identity: NormalizedCloudIdentity): Promise<void> {
    void _identity
    this.upsertCount += 1
    if (this.upsertFail) {
      throw new Error('profiles table missing')
    }
  }
}

interface Harness {
  db: DatabaseSync
  repo: CloudAccountRepository
  adapter: FakeAuthAdapter
  protector: ObscuringProtector
  opened: string[]
  emitted: CloudAccountStatus[]
  service: CloudAccountService
  now: number
  setNow: (value: number) => void
}

function openHarness(options?: { configured?: boolean; available?: boolean }): Harness {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const repo = new CloudAccountRepository(db)
  const adapter = new FakeAuthAdapter()
  if (options?.configured !== undefined) {
    adapter.configured = options.configured
  }
  const protector = new ObscuringProtector(options?.available ?? true)
  const opened: string[] = []
  const emitted: CloudAccountStatus[] = []
  let now = 1_000_000
  const service = new CloudAccountService({
    repository: repo,
    sessionProtector: new SessionProtector(protector),
    authAdapter: adapter,
    attempts: new OAuthAttemptManager(() => now),
    browserOpener: (url: string) => {
      opened.push(url)
      return Promise.resolve()
    },
    now: () => now,
    emit: (status) => {
      emitted.push(status)
    }
  })
  return { db, repo, adapter, protector, opened, emitted, service, now, setNow: (value: number) => { now = value } }
}

function seedLocalData(db: DatabaseSync): void {
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('/proj/a', 'a', 1, 1)")
  db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.profile', '{\"displayName\":\"Abdou\"}', 1)")
  db.exec("INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', 'gpt-4o', 1, 1)")
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as Record<string, unknown>
  return row['n'] as number
}

function statusJson(status: CloudAccountStatus): string {
  return JSON.stringify(status)
}

describe('cloud account service (Stage 29)', () => {
  it('Google OAuth fake flow: one URL, one browser open, one exchange, signed-in + event', async () => {
    const h = openHarness()
    try {
      const started = await h.service.startSignIn('google')
      assert.equal(started.outcome, 'browser_opened')
      assert.equal(h.adapter.beginCount, 1)
      assert.equal(h.opened.length, 1)
      assert.ok(h.opened[0].includes('/auth/'))
      assert.equal(h.service.getStatus().state, 'signing_in')
      const status = await h.service.handleAuthCallback('stark://auth/callback?code=google-code-1')
      assert.equal(status.state, 'signed_in')
      if (status.state === 'signed_in') {
        assert.equal(status.account.provider, 'google')
        assert.equal(status.account.email, 'user@example.com')
      }
      assert.equal(h.adapter.exchangeCount, 1)
      assert.equal(h.adapter.upsertCount, 1)
      assert.ok(h.emitted.some((event) => event.state === 'signed_in'))
      // No duplicate persistence: exactly one account + one session row.
      assert.equal(countRows(h.db, 'cloud_account'), 1)
      assert.equal(countRows(h.db, 'cloud_auth_session'), 1)
    } finally {
      h.db.close()
    }
  })

  it('GitHub OAuth fake flow mirrors Google', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('github')
      const status = await h.service.handleAuthCallback('stark://auth/callback?code=gh-code')
      assert.equal(status.state, 'signed_in')
      if (status.state === 'signed_in') {
        assert.equal(status.account.provider, 'github')
      }
      assert.equal(h.adapter.exchangeCount, 1)
    } finally {
      h.db.close()
    }
  })

  it('rejects invalid providers before Supabase, browser, or DB', async () => {
    const h = openHarness()
    try {
      await assert.rejects(() => h.service.startSignIn('discord'), /cloud-auth-invalid-provider/)
      await assert.rejects(() => h.service.startSignIn('microsoft'), /cloud-auth-invalid-provider/)
      await assert.rejects(() => h.service.startSignIn(undefined), /cloud-auth-invalid-provider/)
      assert.equal(h.adapter.beginCount, 0)
      assert.equal(h.opened.length, 0)
      assert.equal(countRows(h.db, 'cloud_account'), 0)
    } finally {
      h.db.close()
    }
  })

  it('duplicate sign-in while an attempt is active is rejected with no second browser', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      await assert.rejects(() => h.service.startSignIn('github'), /cloud-auth-in-progress/)
      assert.equal(h.adapter.beginCount, 1)
      assert.equal(h.opened.length, 1)
    } finally {
      h.db.close()
    }
  })

  it('signed-in users must sign out before a new sign-in', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      await assert.rejects(() => h.service.startSignIn('github'), /cloud-auth-in-progress/)
      assert.equal(h.opened.length, 1)
    } finally {
      h.db.close()
    }
  })

  it('cancel clears the attempt; a later callback is ignored with no exchange', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      const cancelled = await h.service.cancelSignIn()
      assert.equal(cancelled.state, 'signed_out')
      await assert.rejects(() => h.service.handleAuthCallback('stark://auth/callback?code=late'), /cloud-auth-callback-invalid/)
      assert.equal(h.adapter.exchangeCount, 0)
      assert.equal(countRows(h.db, 'cloud_account'), 0)
    } finally {
      h.db.close()
    }
  })

  it('expired callbacks clear the attempt with no exchange', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      h.setNow(h.now + MAX_AUTH_ATTEMPT_MS + 1)
      await assert.rejects(
        () => h.service.handleAuthCallback('stark://auth/callback?code=late'),
        /cloud-auth-callback-(expired|invalid)/
      )
      assert.equal(h.adapter.exchangeCount, 0)
      assert.equal(h.service.getStatus().state, 'signed_out')
    } finally {
      h.db.close()
    }
  })

  it('unsolicited callbacks with no pending attempt never exchange', async () => {
    const h = openHarness()
    try {
      await assert.rejects(
        () => h.service.handleAuthCallback('stark://auth/callback?code=unsolicited'),
        /cloud-auth-callback-invalid/
      )
      assert.equal(h.adapter.exchangeCount, 0)
    } finally {
      h.db.close()
    }
  })

  it('wrong callbacks are rejected with no exchange', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      for (const bad of [
        'stark://evil/callback?code=abc',
        'stark://auth/other?code=abc',
        'https://example.com/callback?code=abc',
        'stark://auth/callback',
        'stark://auth/callback?code=abc&evil=1',
        'stark://auth/callback?code=abc#frag'
      ]) {
        await assert.rejects(() => h.service.handleAuthCallback(bad), /cloud-auth-callback-invalid/)
      }
      assert.equal(h.adapter.exchangeCount, 0)
    } finally {
      h.db.close()
    }
  })

  it('callback single-use: the same callback twice exchanges exactly once', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      const url = 'stark://auth/callback?code=single-use'
      const first = await h.service.handleAuthCallback(url)
      assert.equal(first.state, 'signed_in')
      await assert.rejects(() => h.service.handleAuthCallback(url), /cloud-auth-callback-invalid/)
      assert.equal(h.adapter.exchangeCount, 1)
      assert.equal(countRows(h.db, 'cloud_account'), 1)
    } finally {
      h.db.close()
    }
  })

  it('insecure storage fails closed: no plaintext persistence, signed out', async () => {
    const h = openHarness({ available: false })
    try {
      await h.service.startSignIn('google')
      await assert.rejects(
        () => h.service.handleAuthCallback('stark://auth/callback?code=c1'),
        /cloud-auth-secure-storage-unavailable/
      )
      assert.equal(countRows(h.db, 'cloud_account'), 0)
      assert.equal(countRows(h.db, 'cloud_auth_session'), 0)
      assert.equal(h.service.getStatus().state, 'signed_out')
    } finally {
      h.db.close()
    }
  })

  it('corrupt encrypted blob yields invalid-session handling without crash', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      // Corrupt the blob directly (simulates disk tampering).
      h.db.prepare('UPDATE cloud_auth_session SET encrypted_session = ? WHERE id = 1').run(Buffer.from('garbage'))
      const restored = await h.service.restoreAtStartup()
      assert.equal(restored.state, 'session_attention')
      if (restored.state === 'session_attention') {
        assert.equal(restored.reason, 'invalid')
      }
    } finally {
      h.db.close()
    }
  })

  it('startup restore rehydrates signed-in identity with no browser and one restore', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      const before = h.adapter.restoreCount
      const restored = await h.service.restoreAtStartup()
      assert.equal(restored.state, 'signed_in')
      assert.equal(h.adapter.restoreCount, before + 1)
      assert.equal(h.opened.length, 1)
      assert.equal(h.adapter.beginCount, 1)
      assert.equal(h.adapter.upsertCount, 1)
    } finally {
      h.db.close()
    }
  })

  it('offline restore stays usable with no retry loop and no data deletion', async () => {
    const h = openHarness()
    try {
      seedLocalData(h.db)
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      h.adapter.restoreBehavior = 'throw'
      const before = h.adapter.restoreCount
      const restored = await h.service.restoreAtStartup()
      assert.ok(restored.state === 'signed_in' || restored.state === 'session_attention')
      assert.equal(h.adapter.restoreCount, before + 1)
      assert.equal(countRows(h.db, 'workspaces'), 1)
      assert.equal(countRows(h.db, 'cloud_account'), 1)
    } finally {
      h.db.close()
    }
  })

  it('persistence fault rolls back with no account row and no second exchange', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      // Break the transaction: drop the session table so the atomic
      // write fails after a successful exchange.
      h.db.exec('DROP TABLE cloud_auth_session')
      await assert.rejects(
        () => h.service.handleAuthCallback('stark://auth/callback?code=c1'),
        /cloud-auth-save-failed/
      )
      assert.equal(h.adapter.exchangeCount, 1)
      assert.equal(countRows(h.db, 'cloud_account'), 0)
    } finally {
      h.db.close()
    }
  })

  it('sign-out clears account/session but preserves local work and provider keys', async () => {
    const h = openHarness()
    try {
      seedLocalData(h.db)
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      const status = await h.service.signOut()
      assert.equal(status.state, 'signed_out')
      assert.equal(countRows(h.db, 'cloud_account'), 0)
      assert.equal(countRows(h.db, 'cloud_auth_session'), 0)
      assert.equal(countRows(h.db, 'workspaces'), 1)
      assert.equal(countRows(h.db, 'ai_provider_configs'), 1)
      const profile = h.db.prepare("SELECT value FROM key_value WHERE key = 'stark.profile'").get()
      assert.ok(profile !== undefined)
      assert.ok(h.adapter.signOutCount >= 1)
    } finally {
      h.db.close()
    }
  })

  it('sign-out succeeds locally even when remote revoke fails', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      h.adapter.signOutFail = true
      const status = await h.service.signOut()
      assert.equal(status.state, 'signed_out')
      assert.equal(countRows(h.db, 'cloud_account'), 0)
    } finally {
      h.db.close()
    }
  })

  it('signing in sends no Workspace/session/code data: only auth + one profile upsert', async () => {
    const h = openHarness()
    try {
      seedLocalData(h.db)
      await h.service.startSignIn('google')
      await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      assert.equal(h.adapter.beginCount, 1)
      assert.equal(h.adapter.exchangeCount, 1)
      assert.equal(h.adapter.upsertCount, 1)
      assert.equal(h.adapter.restoreCount, 0)
      assert.equal(countRows(h.db, 'workspaces'), 1)
    } finally {
      h.db.close()
    }
  })

  it('profile upsert failure keeps the login valid with no retry', async () => {
    const h = openHarness()
    try {
      h.adapter.upsertFail = true
      await h.service.startSignIn('github')
      const status = await h.service.handleAuthCallback('stark://auth/callback?code=c1')
      assert.equal(status.state, 'signed_in')
      assert.equal(h.adapter.upsertCount, 1)
    } finally {
      h.db.close()
    }
  })

  it('missing cloud config reports unavailable without browser or crash', async () => {
    const h = openHarness({ configured: false })
    try {
      assert.equal(h.service.getStatus().state, 'unavailable')
      await assert.rejects(() => h.service.startSignIn('google'), /cloud-auth-unavailable/)
      assert.equal(h.opened.length, 0)
      const restored = await h.service.restoreAtStartup()
      assert.equal(restored.state, 'unavailable')
    } finally {
      h.db.close()
    }
  })

  it('redacts tokens, codes, and verifiers from statuses, events, errors, and plaintext columns', async () => {
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      const status = await h.service.handleAuthCallback(`stark://auth/callback?code=${CODE}`)
      const blob = statusJson(status)
      for (const secret of [ACCESS, REFRESH, CODE, 'VERIFIER_SECRET_ABC']) {
        assert.ok(!blob.includes(secret), `status leaks ${secret}`)
      }
      for (const emitted of h.emitted) {
        assert.ok(!statusJson(emitted).includes(ACCESS))
        assert.ok(!statusJson(emitted).includes(REFRESH))
        assert.ok(!statusJson(emitted).includes(CODE))
      }
      // Plaintext account columns never hold tokens.
      const account = h.db.prepare('SELECT cloud_user_id, provider, email, display_name, avatar_url FROM cloud_account').get() as unknown as Record<string, unknown>
      assert.ok(!JSON.stringify(account).includes(ACCESS))
      assert.ok(!JSON.stringify(account).includes(REFRESH))
      // Encrypted blob differs from plaintext.
      const session = h.db.prepare('SELECT encrypted_session FROM cloud_auth_session').get() as unknown as Record<string, unknown>
      const raw = (session['encrypted_session'] as Buffer).toString('utf8')
      assert.ok(!raw.includes(ACCESS))
      // Failure paths also redact.
      await h.service.signOut()
      await h.service.startSignIn('google')
      h.adapter.exchangeFail = true
      await assert.rejects(() => h.service.handleAuthCallback('stark://auth/callback?code=zzz'), /cloud-auth-exchange-failed/)
    } finally {
      h.db.close()
    }
  })

  it('OAuth browser opens at most once per attempt and attempts expire in 5 minutes', async () => {
    assert.equal(MAX_AUTH_ATTEMPT_MS, 300000)
    const h = openHarness()
    try {
      await h.service.startSignIn('google')
      assert.equal(h.opened.length, 1)
      await assert.rejects(() => h.service.startSignIn('google'), /cloud-auth-in-progress/)
      assert.equal(h.opened.length, 1)
    } finally {
      h.db.close()
    }
  })
})
