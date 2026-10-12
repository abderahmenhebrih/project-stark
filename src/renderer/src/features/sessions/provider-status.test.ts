import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Provider-status single-source invariant: the session banner and the
 * Usage sidebar must render from ONE global readiness value. The
 * optional BYOK lane keeps the not-configured/needs-model/ready
 * selector; globally a signed-in account without BYOK is Free
 * (hosted inference), and only a signed-out session is
 * not-configured — a sign-in prompt, never an OpenAI demand.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('provider status single source', () => {
  it('session banner derives from the BYOK lane with Free and sign-in states', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('providerReadiness(provider.configured, byokModel)'), 'banner readiness must come from providerReadiness over the BYOK model')
    assert.ok(panel.includes('accountSignedIn'), 'global state must know the account sign-in state')
    assert.ok(panel.includes("accountSignedIn ? 'free' : 'not-configured'"), 'signed-in Free must never read as not-configured')
    assert.ok(panel.includes('effectiveSelectedModel('), 'BYOK model must gate disappeared selections')
    assert.ok(panel.includes('canSendWithProvider(readiness)'), 'send gating must use the canonical value')
    // The banner can no longer key one branch on `configured` while
    // Usage keys on something else: both read `readiness`.
    assert.ok(!panel.includes('provider.configured && provider.selectedModel !== null'), 'split inline readiness must be gone')
  })

  it('signed-out sessions get a sign-in prompt, never an OpenAI demand', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Sign in to use STARK Free models.'), 'signed-out copy must prompt sign-in')
    assert.ok(!panel.includes('Connect an AI provider to use Ask and Work.'), 'banner must not demand OpenAI')
    assert.ok(!panel.includes('Add OpenAI key'), 'empty session must not demand a key')
  })

  it('composer sends carry the routing stable id', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('composerModelStableId'), 'sends must carry the selected stable id')
    assert.ok(panel.includes('model: composerModelStableId'), 'all run paths must route explicitly')
  })

  it('chrome snapshot carries readiness and session timestamp', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('providerStatus: readiness'), 'snapshot must carry the canonical status')
    assert.ok(panel.includes('selectedSessionCreatedAt'), 'snapshot must carry the session creation time')
    assert.ok(!panel.includes('providerConfigured: provider.configured'), 'boolean-only mirror must be gone')
  })

  it('usage sidebar renders the same canonical value, never its own', () => {
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    assert.ok(sidebar.includes('providerStatus'), 'sidebar must receive the canonical status')
    assert.ok(sidebar.includes('providerReadinessLabel(providerStatus)'), 'sidebar must label the canonical value')
    assert.ok(!sidebar.includes('provider.configured'), 'sidebar must not recompute readiness itself')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('providerStatus={chromeSession?.providerStatus'), 'shell must mirror the canonical status')
    assert.ok(home.includes('selectedSessionCreatedAt'), 'shell must mirror the session timestamp')
  })

  it('shell comparison tracks the new snapshot fields', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('prev.providerStatus === next.providerStatus'), 'snapshot comparison must track readiness')
    assert.ok(home.includes('prev.selectedSessionCreatedAt === next.selectedSessionCreatedAt'), 'snapshot comparison must track the timestamp')
  })
})
