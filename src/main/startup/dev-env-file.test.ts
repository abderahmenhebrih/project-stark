import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import type { CredentialProtector } from '../ai/credential-protector'
import { CloudAccountRepository } from '../cloud-account/cloud-account-repository'
import { SessionProtector } from '../cloud-account/cloud-auth-session-store'
import { CloudAccountService } from '../cloud-account/cloud-account-service'
import { OAuthAttemptManager } from '../cloud-account/oauth-attempt-manager'
import {
  isUnsafeSupabaseValue,
  loadSupabasePublicConfig,
  SupabaseAuthAdapter
} from '../cloud-account/supabase-auth-adapter'
import { DEV_ENV_ALLOWED_KEYS, loadDevEnvFile, parseDevEnvFile } from './dev-env-file'

function root(): string {
  return process.cwd()
}

describe('dev env file parsing', () => {
  it('parses dotenv shapes and drops everything outside the allowlist', () => {
    const parsed = parseDevEnvFile(
      '# comment\n' +
        'SUPABASE_URL=https://abc.supabase.co\n' +
        "SUPABASE_ANON_KEY='public-anon'\n" +
        'export SUPABASE_PUBLISHABLE_KEY="publishable"\n' +
        'PATH=/evil\n' +
        'SUPABASE_URL=https://second.example\n' +
        'MALFORMED\n' +
        '\n'
    )
    assert.deepEqual(parsed, {
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_ANON_KEY: 'public-anon',
      SUPABASE_PUBLISHABLE_KEY: 'publishable'
    })
    assert.deepEqual(parseDevEnvFile(''), {})
    assert.deepEqual(parseDevEnvFile('# only comments\n'), {})
  })

  it('honors only the exact fixed redirect value', () => {
    assert.deepEqual(parseDevEnvFile('STARK_AUTH_REDIRECT_URL=stark://auth/callback\n'), {
      STARK_AUTH_REDIRECT_URL: 'stark://auth/callback'
    })
    assert.deepEqual(parseDevEnvFile('STARK_AUTH_REDIRECT_URL=https://evil.example/cb\n'), {})
  })

  it('exposes a public-config-only allowlist', () => {
    assert.ok(DEV_ENV_ALLOWED_KEYS.includes('SUPABASE_URL'))
    assert.ok(DEV_ENV_ALLOWED_KEYS.includes('SUPABASE_ANON_KEY'))
    for (const forbidden of ['PATH', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SECRET', 'TOKEN']) {
      assert.ok(!DEV_ENV_ALLOWED_KEYS.includes(forbidden), `allowlist must not contain ${forbidden}`)
    }
  })
})

describe('dev env file loading', () => {
  it('applies missing keys in dev without overriding explicit env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-devenv-'))
    try {
      writeFileSync(
        join(dir, '.env.local'),
        'SUPABASE_URL=https://abc.supabase.co\nSUPABASE_ANON_KEY=public-anon\nPATH=/evil\n'
      )
      const env: NodeJS.ProcessEnv = { SUPABASE_ANON_KEY: 'explicit-anon' }
      const result = loadDevEnvFile({ appPath: dir, isPackaged: false, env })
      assert.equal(result.loaded, true)
      assert.deepEqual([...result.appliedKeys].sort(), ['SUPABASE_URL'])
      assert.equal(env['SUPABASE_URL'], 'https://abc.supabase.co')
      assert.equal(env['SUPABASE_ANON_KEY'], 'explicit-anon')
      assert.equal(env['PATH'], undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a silent no-op for packaged builds even with a file present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-devenv-prod-'))
    try {
      writeFileSync(join(dir, '.env.local'), 'SUPABASE_URL=https://abc.supabase.co\n')
      const env: NodeJS.ProcessEnv = {}
      const result = loadDevEnvFile({ appPath: dir, isPackaged: true, env })
      assert.deepEqual(result, { loaded: false, appliedKeys: [] })
      assert.equal(env['SUPABASE_URL'], undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores missing and oversized files without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-devenv-missing-'))
    try {
      const env: NodeJS.ProcessEnv = {}
      assert.deepEqual(loadDevEnvFile({ appPath: join(dir, 'nope'), isPackaged: false, env }), {
        loaded: false,
        appliedKeys: []
      })
      assert.equal(env['SUPABASE_URL'], undefined)
      writeFileSync(join(dir, '.env.local'), 'SUPABASE_URL=https://abc.supabase.co\n')
      // A directory named .env.local is unreadable as a file: no-op.
      rmSync(join(dir, '.env.local'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never logs values (names only, and only to the caller)', () => {
    const source = readFileSync(join(root(), 'src', 'main', 'startup', 'dev-env-file.ts'), 'utf8')
    assert.ok(!source.includes('console.'), 'loader must not log at all')
  })
})

describe('supabase public config policy', () => {
  it('accepts valid public config and rejects everything unsafe', () => {
    assert.deepEqual(
      loadSupabasePublicConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'public-anon' }),
      { url: 'https://abc.supabase.co', anonKey: 'public-anon' }
    )
    assert.equal(loadSupabasePublicConfig({}), null)
    assert.equal(loadSupabasePublicConfig({ SUPABASE_URL: 'https://abc.supabase.co' }), null)
    assert.equal(loadSupabasePublicConfig({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_ANON_KEY: 'k' }), null)
    // service_role-shaped values fail closed (both positions).
    assert.equal(
      loadSupabasePublicConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'service_role-key' }),
      null
    )
    assert.equal(
      loadSupabasePublicConfig({ SUPABASE_URL: 'https://service_role.example', SUPABASE_ANON_KEY: 'k' }),
      null
    )
    assert.equal(isUnsafeSupabaseValue('service_role-key'), true)
    assert.equal(isUnsafeSupabaseValue('public-anon'), false)
    assert.equal(isUnsafeSupabaseValue(undefined), false)
  })
})

describe('auth config states over real env', () => {
  function openService(env: NodeJS.ProcessEnv): { db: DatabaseSync; service: CloudAccountService } {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, migrations)
    const protector: CredentialProtector = {
      isAvailable: () => Promise.resolve(true),
      encrypt: (secret: string) => Promise.resolve(Buffer.from(`fake:${secret}`, 'utf8')),
      decrypt: (ciphertext: Buffer) => Promise.resolve({ secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false })
    }
    const service = new CloudAccountService({
      repository: new CloudAccountRepository(db),
      sessionProtector: new SessionProtector(protector),
      authAdapter: new SupabaseAuthAdapter(loadSupabasePublicConfig(env)),
      attempts: new OAuthAttemptManager(),
      browserOpener: () => Promise.resolve()
    })
    return { db, service }
  }

  it('missing config reports unavailable; valid config reports signed_out', () => {
    const missing = openService({})
    try {
      assert.equal(missing.service.getStatus().state, 'unavailable')
    } finally {
      missing.db.close()
    }
    const valid = openService({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'public-anon' })
    try {
      assert.equal(valid.service.getStatus().state, 'signed_out')
    } finally {
      valid.db.close()
    }
  })

  it('unsafe config reports unavailable (never signed_out, never signed_in)', () => {
    const unsafe = openService({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'service_role-key' })
    try {
      assert.equal(unsafe.service.getStatus().state, 'unavailable')
    } finally {
      unsafe.db.close()
    }
  })

  it('dev file values flow into the service states end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-devenv-e2e-'))
    const env: NodeJS.ProcessEnv = {}
    try {
      writeFileSync(join(dir, '.env.local'), 'SUPABASE_URL=https://abc.supabase.co\nSUPABASE_ANON_KEY=public-anon\n')
      const loaded = loadDevEnvFile({ appPath: dir, isPackaged: false, env })
      assert.equal(loaded.loaded, true)
      const { db, service } = openService(env)
      try {
        assert.equal(service.getStatus().state, 'signed_out')
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('auth secret boundaries', () => {
  it('.env.example ships placeholders only and stays committable', () => {
    const file = join(root(), '.env.example')
    assert.ok(existsSync(file), '.env.example must exist')
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('SUPABASE_URL=https://YOUR_PROJECT.supabase.co'), 'example must show a placeholder URL')
    assert.ok(text.includes('SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY'), 'example must show a placeholder key')
    assert.ok(text.includes('NEVER'), 'example must warn against service_role')
    assert.ok(!text.includes('service_role=') && !text.includes('eyJ'), 'example must carry no real credential')
  })

  it('git ignores local env files but keeps the example', () => {
    const ignore = readFileSync(join(root(), '.gitignore'), 'utf8')
    const rules = ignore.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
    for (const pattern of ['.env', '.env.local', '.env.*.local']) {
      assert.ok(rules.includes(pattern), `gitignore must cover ${pattern}`)
    }
    // The only wildcard rule requires a `.local` suffix, which
    // `.env.example` does not have — the example stays committable.
    assert.ok(!rules.includes('.env.example'), 'gitignore must not list .env.example')
    assert.ok(!'.env.example'.endsWith('.local'), 'wildcard guard: example has no .local suffix')
  })

  it('renderer and preload never receive Supabase keys', () => {
    const preload = readFileSync(join(root(), 'src', 'preload', 'index.ts'), 'utf8')
    for (const forbidden of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY']) {
      assert.ok(!preload.includes(forbidden), `preload must not reference ${forbidden}`)
    }
    // Executable renderer account state carries no tokens: the shared
    // validator rejects secret-bearing keys (its denylist names them
    // precisely so regressions fail closed — assert the behavior).
    const accountTypes = readFileSync(join(root(), 'src', 'shared', 'cloud-account', 'types.ts'), 'utf8')
    assert.ok(accountTypes.includes('function isCloudAccountStatus'), 'status validator must exist')
    for (const key of ['accessToken', 'refreshToken', 'code', 'session', 'verifier', 'token']) {
      assert.ok(accountTypes.includes(`'${key}'`), `validator must reject ${key}`)
    }
    assert.ok(!accountTypes.includes('accessToken:'), 'no token field may exist on renderer state')
    assert.ok(!accountTypes.includes('refreshToken:'), 'no token field may exist on renderer state')
  })

  it('auth diagnostics log booleans only', () => {
    const index = readFileSync(join(root(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const diagAt = index.indexOf('function printAuthConfigDiag')
    assert.ok(diagAt >= 0, 'auth diag must exist')
    const diag = index.slice(diagAt, index.indexOf('\n}\n', diagAt))
    assert.ok(diag.includes('[STARK AUTH DIAG]'), 'diag marker must remain')
    assert.ok(diag.includes('devEnvFile='), 'diag must report file load state')
    assert.ok(diag.includes('unsafeRefused='), 'diag must report refusal state')
    assert.ok(!diag.includes('${url}') && !diag.includes('${anonKey}'), 'diag must never interpolate values')
    assert.ok(diag.includes('if (app.isPackaged) {\n    return'), 'diag must stay dev-only')
  })
})
