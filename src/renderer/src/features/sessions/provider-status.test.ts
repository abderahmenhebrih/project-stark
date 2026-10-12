import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Provider-status single-source invariant: the session banner and the
 * Usage sidebar must render from ONE canonical readiness value, so the
 * reported contradiction ("AI provider not connected yet" beside
 * "OpenAI · configured") is impossible.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('provider status single source', () => {
  it('session banner derives from the canonical selector', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes("providerReadiness(provider.configured, provider.selectedModel)"), 'banner readiness must come from providerReadiness')
    assert.ok(panel.includes('canSendWithProvider(readiness)'), 'send gating must use the canonical value')
    // The banner can no longer key one branch on `configured` while
    // Usage keys on something else: both read `readiness`.
    assert.ok(!panel.includes('provider.configured && provider.selectedModel !== null'), 'split inline readiness must be gone')
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
