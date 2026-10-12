import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Signed-out guidance: a session with no runnable provider and no
 * signed-in account shows the sign-in prompt — never an OpenAI
 * demand. Signed-in Free sessions show the Free selection. The only
 * action navigates to Settings → Account. Local session stays
 * usable; guidance never gates local use.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('signed-out AI guidance', () => {
  it('session notice pairs the sign-in copy with an Account action', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(
      panel.includes('Sign in to use STARK Free models.'),
      'signed-out notice copy must remain'
    )
    assert.ok(panel.includes('Sign in'), 'notice must offer a Sign in action')
    assert.ok(
      panel.includes("onOpenSettings('account')"),
      'Sign in must navigate to Settings → Account'
    )
    assert.ok(
      !panel.includes('Connect an AI provider to use Ask and Work.'),
      'notice must never demand an external provider'
    )
  })

  it('empty session explains sign-in with one actionable control', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(
      panel.includes('Sign in to use STARK Free models.'),
      'empty session must explain the sign-in requirement'
    )
    assert.ok(!panel.includes('Add OpenAI key'), 'empty session must not demand a key')
    assert.ok(panel.includes('session__empty-ai'), 'guidance must be styled without touching the watermark')
    // The watermark stays decorative; guidance never gates local use.
    assert.ok(panel.includes('session__watermark'), 'wordmark watermark must be preserved')
  })

  it('shell wires the guidance action to the settings surface', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(
      home.includes('onOpenSettings={handleOpenSettings}'),
      'shell must forward settings opening to the session panel'
    )
    const props = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(
      props.includes('onOpenSettings?: (section: SettingsSection) => void'),
      'action must be optional so tests and embeds keep working'
    )
  })

  it('BYOK-ready and signed-in Free hide the guidance (no forced redirect)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    // Both CTAs render only under !aiReady; ready branches render
    // the model notice with no action.
    assert.ok(panel.includes('!aiReady'), 'guidance must be conditional on provider state')
    assert.ok(
      !panel.includes('autoOpenSettings') && !panel.includes('forceOpenSettings'),
      'no automatic settings redirect may exist'
    )
  })
})
