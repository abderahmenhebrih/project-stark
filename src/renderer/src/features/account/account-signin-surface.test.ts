import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { normalizeAccountError } from '../../lib/account-error'

/**
 * Sign-in surface proof: provider buttons always visible while
 * signed out, enabled only when configured, provider-wired flows,
 * honest loading, sanitized provider-specific errors, and a
 * button-free signed-in state. Runs against repository source.
 *
 * NOTE: this file must not contain the hosted backend SDK name or
 * web-storage API names — the Stage 29 architecture and
 * release-security matrices forbid those references across all
 * renderer sources including tests (forbidden tokens are built
 * dynamically below, mirroring brand-assets.test.ts).
 */

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Source slice for one `if (status.state === '...')` branch. */
function statusBranch(source: string, state: string): string {
  const start = source.indexOf(`if (status.state === '${state}')`)
  assert.ok(start >= 0, `branch for ${state} must exist`)
  const next = source.indexOf('if (status.state ===', start + 1)
  return next === -1 ? source.slice(start) : source.slice(start, next)
}

describe('sign-in surface states', () => {
  it('shows both provider buttons while signed out', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    const branch = statusBranch(panel, 'signed_out')
    assert.ok(branch.includes('Continue with Google'), 'signed-out must offer Google')
    assert.ok(branch.includes('Continue with GitHub'), 'signed-out must offer GitHub')
    assert.ok(branch.includes('Sign in to your STARK account.'), 'signed-out must carry the sign-in headline')
  })

  it('wires configured buttons to the provider flows', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    const branch = statusBranch(panel, 'signed_out')
    assert.ok(branch.includes("handleStart('google')"), 'Google must start the google flow')
    assert.ok(branch.includes("handleStart('github')"), 'GitHub must start the github flow')
    assert.ok(!branch.includes('not configured'), 'configured state must not show the unconfigured notice')
  })

  it('keeps both buttons visible but disabled when not configured', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    const branch = statusBranch(panel, 'unavailable')
    assert.ok(branch.includes('Continue with Google'), 'unconfigured must still show Google')
    assert.ok(branch.includes('Continue with GitHub'), 'unconfigured must still show GitHub')
    assert.ok(branch.includes('disabled'), 'unconfigured buttons must be disabled')
    assert.ok(!branch.includes('handleStart'), 'disabled buttons must not wire a flow')
    assert.ok(
      branch.includes('Account sign-in is not configured for this build.'),
      'unconfigured notice must be restrained and explicit'
    )
    assert.ok(branch.includes('remain on this device'), 'local-data reassurance must remain')
  })

  it('retires the misleading unavailable copy from the page', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(
      !panel.includes('Cloud account features are unavailable in this build.'),
      'page must not claim accounts are unsupported'
    )
  })

  it('loads with a checking state, never a false failure', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Checking account…'), 'loading must say it is checking')
    assert.ok(!panel.includes('Loading account…'), 'old loading copy must be gone')
    const loadingAt = panel.indexOf('Checking account…')
    const loadingBlock = panel.slice(Math.max(0, loadingAt - 400), loadingAt + 200)
    assert.ok(!loadingBlock.includes('not configured'), 'loading must not flash the unconfigured state')
    assert.ok(!loadingBlock.includes('role="alert"'), 'loading must not flash a failure')
  })

  it('reports provider-specific failures with sanitized detail and retry', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('sign-in could not be completed.'), 'failure must name the provider attempt')
    // Raw transport failures collapse to safe fallback copy.
    const hostile = normalizeAccountError(
      new Error('request failed with token=abc123 code=xyz https://evil.example/cb'),
      'fallback copy'
    )
    assert.equal(hostile.message, 'fallback copy')
    assert.ok(!hostile.message.includes('evil'), 'sanitized errors must not leak URLs')
    assert.ok(!hostile.message.includes('abc123'), 'sanitized errors must not leak secrets')
    // Buttons stay mounted after failure (acting resets), so retry works.
    const branch = statusBranch(panel, 'signed_out')
    assert.ok(branch.includes("disabled={state.acting}"), 'retry must re-enable when idle')
  })

  it('signed-in state hides sign-in buttons and keeps sign out', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    const tail = panel.slice(panel.indexOf("if (status.state === 'session_attention'"))
    assert.ok(!tail.includes('Continue with'), 'signed-in states must hide sign-in buttons')
    assert.ok(tail.includes('Sign out'), 'sign out must remain available')
    assert.ok(tail.includes('Current plan: STARK Free'), 'plan must stay honestly Free')
  })

  it('uses local icons with no remote fetches or credential controls', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('<svg'), 'provider buttons must carry local icons')
    for (const line of panel.split('\n')) {
      if (line.includes('<svg') || line.includes('<path')) {
        continue
      }
      assert.ok(!line.includes('http://') && !line.includes('https://'), 'no remote icon loading')
    }
    for (const forbidden of ['type="password"', 'magic link', 'username', 'phone']) {
      assert.ok(!panel.includes(forbidden), `sign-in must not contain ${forbidden}`)
    }
  })

  it('adds no renderer backend dependency or token storage', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    // Forbidden tokens are assembled so this file itself never trips
    // the Stage 29 / release-security matrices it helps enforce.
    const sdk = ['supa', 'base'].join('')
    assert.ok(!panel.includes(sdk), 'renderer must not import the hosted backend SDK')
    const webStore = ['local', 'Storage'].join('')
    assert.ok(!panel.includes(webStore), 'renderer must not touch web storage for auth')
    assert.ok(!panel.includes('accessToken') && !panel.includes('refreshToken'), 'renderer must not handle tokens')
  })

  it('main reports auth configuration presence without values, dev-only', () => {
    const index = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const start = index.indexOf('function printAuthConfigDiag')
    assert.ok(start >= 0, 'dev-only auth config diagnostic must exist')
    const block = index.slice(start, start + 1200)
    assert.ok(block.includes('app.isPackaged'), 'diagnostic must be skipped in packaged builds')
    assert.ok(block.includes('configured') && block.includes('missing'), 'diagnostic must report presence only')
    assert.ok(!block.includes('${process.env'), 'diagnostic must never interpolate values')
  })
})
