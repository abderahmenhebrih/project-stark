import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

/** Strips line/block comments and CSS so doc prose is not mistaken for code. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

const MONETIZATION_FILES = [
  'features/monetization/sponsored-working/sponsor-types.ts',
  'features/monetization/sponsored-working/sponsor-policy.ts',
  'features/monetization/sponsored-working/sponsor-lifecycle.ts',
  'features/monetization/sponsored-working/sponsor-provider.ts',
  'features/monetization/sponsored-working/sponsor-viewability.ts',
  'features/monetization/sponsored-working/sponsor-telemetry.ts',
  'features/monetization/sponsored-working/sponsor-economics.ts',
  'features/monetization/sponsored-working/SponsoredWorkingSlot.tsx',
  'features/monetization/sponsored-working/SponsoredWorkingSlot.css'
] as const

describe('sponsor security (no executable / network / secret surface)', () => {
  it('no arbitrary HTML, scripts, iframes, eval, or pixels', () => {
    for (const file of MONETIZATION_FILES) {
      const source = codeOnly(readRenderer(file))
      for (const forbidden of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        '__html',
        'eval(',
        '<script',
        '<iframe',
        'tracking pixel'
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
      // Bare 'pixel' only counts in code (comments/CSS prose excluded above).
      assert.ok(!/\bpixel\b/i.test(source), `${file} must not contain executable pixel code}`)
    }
  })

  it('zero sponsor-network requests (no fetch, domains, CSP, cookies)', () => {
    for (const file of MONETIZATION_FILES) {
      const source = readRenderer(file)
      for (const forbidden of [
        'fetch(',
        'XMLHttpRequest',
        'advertiser',
        'campaign',
        'auction',
        'fingerprint',
        'cookie',
        'Content-Security-Policy'
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })

  it('no generic IPC, secrets, Node, shell, or filesystem access', () => {
    for (const file of MONETIZATION_FILES) {
      const source = readRenderer(file)
      for (const forbidden of ['ipcRenderer', 'ipcMain', 'apiKey', 'secret', 'process.env', 'child_process', 'node:fs', 'node:pty', 'shell']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    const slot = readRenderer('features/monetization/sponsored-working/SponsoredWorkingSlot.tsx')
    assert.ok(!slot.includes('window.stark'), 'slot must not reach the privileged bridge')
  })

  it('no invasive presence tracking (visibility/focus only)', () => {
    const viewability = readRenderer('features/monetization/sponsored-working/sponsor-viewability.ts')
    for (const forbidden of ['mousemove', 'keydown', 'keystroke', 'cursor', 'coordinates', 'opened source', 'repository activity']) {
      assert.ok(!viewability.includes(forbidden), `viewability must not contain ${forbidden}`)
    }
    assert.ok(viewability.includes('visibilityState') || viewability.includes('readAppVisible'))
    assert.ok(viewability.includes('hasFocus') || viewability.includes('readAppFocused'))
  })

  it('no polling loops or unbounded timers', () => {
    for (const file of MONETIZATION_FILES) {
      const source = readRenderer(file)
      assert.ok(!source.includes('setInterval'), `${file} must not poll`)
      for (const forbidden of ['while (true)', 'for (;;)', 'infinite retry', 'unbounded']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })
})
