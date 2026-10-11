import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Hackathon stabilization (no-provider dead-end): a fresh user with no
 * AI provider configured must see a clear Connect-AI action — never a
 * dead-end notice. Local session stays usable; the CTA only navigates
 * to the existing Settings → Models key surface.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('no-provider AI guidance', () => {
  it('session notice pairs the local-session copy with a Connect AI action', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(
      panel.includes('Local session — AI provider not connected yet.'),
      'unconfigured notice copy must remain'
    )
    assert.ok(panel.includes('Connect AI'), 'notice must offer a Connect AI action')
    assert.ok(
      panel.includes("onOpenSettings('models')"),
      'Connect AI must navigate to Settings → Models'
    )
  })

  it('empty session explains Ask/Work need a provider with one actionable control', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(
      panel.includes('Connect an AI provider to use Ask and Work.'),
      'empty session must explain the provider requirement'
    )
    assert.ok(panel.includes('Add OpenAI key'), 'empty session must offer the key action')
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

  it('configured provider hides the guidance (no forced redirect)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    // Both CTAs render only under !aiReady; the configured branch
    // renders the OpenAI · model notice with no action.
    assert.ok(panel.includes('!aiReady'), 'guidance must be conditional on provider state')
    assert.ok(
      !panel.includes('autoOpenSettings') && !panel.includes('forceOpenSettings'),
      'no automatic settings redirect may exist'
    )
  })
})
