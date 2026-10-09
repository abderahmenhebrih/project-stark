import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildExtensionHostEnv, EXTENSION_HOST_ENV_ALLOWLIST } from './environment'

describe('extension host environment isolation', () => {
  it('passes only allowlisted operational keys', () => {
    const env = buildExtensionHostEnv({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'gho-secret'
    })
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['LANG'], 'en_US.UTF-8')
    assert.equal(env['HOME'], '/home/dev')
    assert.ok(!('OPENAI_API_KEY' in env))
    assert.ok(!('GITHUB_TOKEN' in env))
  })

  it('drops every provider, OAuth, and session secret by name', () => {
    const hostile: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: 'sk-y',
      SUPABASE_SERVICE_ROLE: 'role',
      SUPABASE_ANON_KEY: 'anon',
      OAUTH_TOKEN: 'tok',
      SESSION_SECRET: 'sess',
      DB_PASSWORD: 'pw',
      AUTH_BEARER: 'bearer',
      CREDENTIALS_FILE: '/x',
      PRIVATE_KEY: 'priv',
      SIGNATURE_SECRET: 'sig',
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows'
    }
    const env = buildExtensionHostEnv(hostile)
    for (const name of Object.keys(hostile)) {
      if (name === 'PATH' || name === 'SystemRoot') {
        continue
      }
      assert.ok(!(name in env), `${name} must not reach the host`)
    }
    for (const value of Object.values(env)) {
      assert.ok(typeof value === 'string' && !value.includes('sk-'), 'no secret material may pass through')
    }
  })

  it('returns a fresh object and never the parent reference', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const env = buildExtensionHostEnv(parent)
    assert.ok(env !== parent)
    env['PATH'] = '/mutated'
    assert.equal(parent['PATH'], '/usr/bin')
  })

  it('allowlist stays minimal and secret-free', () => {
    assert.ok(EXTENSION_HOST_ENV_ALLOWLIST.length <= 20, 'allowlist must stay tiny')
    for (const name of EXTENSION_HOST_ENV_ALLOWLIST) {
      assert.ok(!/key|token|secret|password|credential|auth/i.test(name), `${name} must not look secret-bearing`)
    }
  })
})
