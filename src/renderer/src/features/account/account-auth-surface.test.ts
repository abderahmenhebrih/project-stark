import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Account auth surface proof: Google/GitHub only, no credential
 * forms, sanitized renderer state, honest unconfigured behavior, and
 * the existing main test suite covering the mocked hosted-auth
 * adapter (provider allowlist, callback validation, secure session,
 * sign-out, restore, redaction). No live network anywhere.
 *
 * NOTE: this file must not name the hosted backend SDK or web
 * storage APIs — the Stage 29 architecture and release-security
 * matrices forbid those references across all renderer sources
 * including tests.
 */

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

function readMainTest(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'main', relative), 'utf8')
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Extracts one interface block so guard lists are not mistaken for state. */
function interfaceBlock(source: string, name: string): string {
  const start = source.indexOf(`interface ${name}`)
  if (start < 0) {
    return ''
  }
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0) {
    return ''
  }
  return source.slice(open, close + 1)
}

describe('account auth surface (Google/GitHub only)', () => {
  it('offers exactly Google and GitHub with no credential forms', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Continue with Google'), 'must offer Google')
    assert.ok(panel.includes('Continue with GitHub'), 'must offer GitHub')
    for (const forbidden of ['password', 'magic link', 'magic-link', 'username', 'Email code']) {
      assert.ok(!panel.includes(forbidden), `account must not contain ${forbidden}`)
    }
    assert.ok(panel.includes('type="button"'), 'providers must be explicit buttons')
  })

  it('shows the Free plan and preserves sign out without touching local data', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Current plan: STARK Free'), 'signed-in accounts must see the Free plan')
    assert.ok(panel.includes('Sign out'), 'must offer sign out')
    assert.ok(panel.includes('remain on this device') || panel.includes('remain local'), 'sign out must reassure local data')
  })

  it('fails safely when sign-in is not configured', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Account sign-in is not configured for this build.'), 'unconfigured auth must say so plainly')
  })

  it('renderer identity types carry no token fields', () => {
    const contract = codeOnly(
      readFileSync(join(process.cwd(), 'src', 'shared', 'cloud-account', 'types.ts'), 'utf8')
    )
    assert.ok(contract.includes("'google' | 'github'"), 'contract must allow exactly Google/GitHub')
    for (const block of [interfaceBlock(contract, 'SafeCloudAccount')]) {
      assert.ok(block.length > 0, 'safe account type must exist')
      for (const secret of ['accessToken', 'refreshToken', 'idToken', 'verifier', 'code']) {
        assert.ok(!block.includes(secret), `safe account type must not carry ${secret}`)
      }
    }
    const guard = codeOnly(readRenderer('features/account/account-state.ts'))
    assert.ok(guard.includes('isSafeAccountStatusPayload'), 'pushed payloads must be screened')
  })

  it('main suite proves the mocked adapter boundaries', () => {
    const service = readMainTest('cloud-account/cloud-account-service.test.ts')
    for (const proof of [
      'rejects invalid providers',
      'GitHub OAuth fake flow mirrors Google',
      'sign-out clears account/session but preserves local work',
      'missing cloud config reports unavailable',
      'redacts tokens, codes, and verifiers',
      'startup restore rehydrates signed-in identity',
      'sends no Workspace/session/code data'
    ]) {
      assert.ok(service.includes(proof), `main suite must prove: ${proof}`)
    }
    const deepLink = readMainTest('cloud-account/deep-link.test.ts')
    for (const proof of ['rejects wrong hosts and paths', 'rejects foreign schemes', 'rejects missing code']) {
      assert.ok(deepLink.includes(proof), `callback suite must prove: ${proof}`)
    }
    const store = readMainTest('cloud-account/cloud-auth-session-store.test.ts')
    assert.ok(store.includes('fails closed when secure storage is unavailable'), 'session must fail closed')
  })
})
