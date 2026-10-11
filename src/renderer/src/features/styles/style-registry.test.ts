import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { defaultProductState, deriveAccountEntitlements, productionEntitlements } from '../billing/entitlements'

/** Runs a callback with a flagged renderer URL present on globalThis. */
function withFlaggedUrl(run: () => void): void {
  withSearch('?stark-dev-styles=all', run)
}

/** Runs a callback with a plain renderer URL (no dev flag). */
function withPlainUrl(run: () => void): void {
  withSearch('?other=1', run)
}

function withSearch(search: string, run: () => void): void {
  const holder = globalThis as unknown as { window?: unknown }
  const previous = holder.window
  holder.window = { location: { search } }
  try {
    run()
  } finally {
    if (previous === undefined) {
      delete holder.window
    } else {
      holder.window = previous
    }
  }
}
import { devFixtureProductState } from '../billing/entitlements'
import {
  STARK_STYLES,
  canApplyStyle,
  fallbackStyle,
  findStyleDefinition,
  resolveDevStyleUnlock
} from './style-registry'

describe('style registry', () => {
  it('defines exactly four styles with tier asset families', () => {
    assert.deepEqual(
      STARK_STYLES.map((entry) => entry.id),
      ['free', 'magma', 'frost', 'void']
    )
    assert.deepEqual(
      STARK_STYLES.map((entry) => entry.label),
      ['STARK', 'STARK Magma', 'STARK Frost', 'STARK Void']
    )
    for (const entry of STARK_STYLES) {
      assert.equal(entry.secondary, '#ff2ea6', 'magenta stays the secondary accent in every style')
      assert.ok(entry.primary !== '#ff2ea6', 'primary must differ from the magenta accent')
      assert.ok(entry.fullLogoFile.endsWith('.png') && entry.iconFile.endsWith('.png') && entry.wordmarkFile.endsWith('.png'))
    }
  })

  it('maps each style to its own local asset family', () => {
    const byId = new Map(STARK_STYLES.map((entry) => [entry.id, entry] as const))
    const free = byId.get('free')
    const magma = byId.get('magma')
    const frost = byId.get('frost')
    const voidStyle = byId.get('void')
    assert.ok(free && magma && frost && voidStyle, 'all four styles must exist')
    assert.ok(!free.iconFile.includes('magma') && !free.iconFile.includes('frost') && !free.iconFile.includes('void'))
    assert.ok(magma.iconFile.includes('magma') && magma.wordmarkFile.includes('magma') && magma.fullLogoFile.includes('magma'))
    assert.ok(frost.iconFile.includes('frost') && frost.wordmarkFile.includes('frost') && frost.fullLogoFile.includes('frost'))
    assert.ok(voidStyle.iconFile.includes('void') && voidStyle.wordmarkFile.includes('void') && voidStyle.fullLogoFile.includes('void'))
    assert.equal(findStyleDefinition('magma').label, 'STARK Magma')
  })

  it('Free unlocks free only; Magma adds magma; Frost adds frost', () => {
    assert.equal(canApplyStyle('free', productionEntitlements()), true)
    assert.equal(canApplyStyle('magma', productionEntitlements()), false)
    const magma = deriveAccountEntitlements(devFixtureProductState('magma'))
    assert.equal(canApplyStyle('free', magma), true)
    assert.equal(canApplyStyle('magma', magma), true)
    assert.equal(canApplyStyle('frost', magma), false)
    assert.equal(canApplyStyle('void', magma), false)
    const frost = deriveAccountEntitlements(devFixtureProductState('frost'))
    assert.equal(canApplyStyle('frost', frost), true)
    assert.equal(canApplyStyle('void', frost), false)
  })

  it('voidActivatedEver unlocks all four styles permanently', () => {
    const entitlements = deriveAccountEntitlements(devFixtureProductState('void-activated-empty'))
    for (const id of ['free', 'magma', 'frost', 'void'] as const) {
      assert.equal(canApplyStyle(id, entitlements), true)
    }
  })

  it('a locked style cannot be applied', () => {
    assert.equal(canApplyStyle('frost', productionEntitlements()), false)
    assert.equal(canApplyStyle('void', productionEntitlements()), false)
  })

  it('lapsed subscriptions fall back to the highest entitled style', () => {
    const free = productionEntitlements()
    assert.equal(fallbackStyle('frost', free), 'free')
    assert.equal(fallbackStyle('magma', free), 'free')
    assert.equal(fallbackStyle('free', free), 'free')
    const voidKept = deriveAccountEntitlements(devFixtureProductState('void-activated-empty'))
    assert.equal(fallbackStyle('frost', voidKept), 'frost')
    const magma = deriveAccountEntitlements(devFixtureProductState('magma'))
    assert.equal(fallbackStyle('frost', magma), 'magma')
  })

  it('no dev unlock leaks into normal runs', () => {
    assert.equal(resolveDevStyleUnlock(), null)
  })

  it('development fixture previews all styles with dev flag plus query flag', () => {
    withFlaggedUrl(() => {
      assert.deepEqual(resolveDevStyleUnlock({ dev: true }), ['free', 'magma', 'frost', 'void'])
    })
  })

  it('development fixture needs both flags (dev alone is not enough)', () => {
    withFlaggedUrl(() => {
      assert.equal(resolveDevStyleUnlock({ dev: false }), null)
      assert.equal(resolveDevStyleUnlock(), null)
      assert.equal(resolveDevStyleUnlock({}), null)
    })
    withPlainUrl(() => {
      assert.equal(resolveDevStyleUnlock({ dev: true }), null)
    })
  })

  it('production ignores the query parameter completely', () => {
    withFlaggedUrl(() => {
      // Every non-dev invocation returns null even with the flag present.
      assert.equal(resolveDevStyleUnlock(), null)
      assert.equal(resolveDevStyleUnlock({ dev: false }), null)
    })
  })

  it('production Free remains entitled only to the Free style', () => {
    const entitlements = productionEntitlements()
    assert.deepEqual([...entitlements.unlockedStyles], ['free'])
    assert.equal(canApplyStyle('magma', entitlements), false)
    assert.equal(canApplyStyle('frost', entitlements), false)
    assert.equal(canApplyStyle('void', entitlements), false)
  })

  it('query parameter cannot unlock functional benefits', () => {
    withFlaggedUrl(() => {
      // Entitlements never read the URL: Free stays Free in every dimension.
      const entitlements = deriveAccountEntitlements(defaultProductState())
      assert.equal(entitlements.basePlan, 'free')
      assert.equal(entitlements.maxBrainModels, 5)
      assert.equal(entitlements.maxHeartModels, 5)
      assert.equal(entitlements.pluginsEnabled, false)
      assert.equal(entitlements.adFree, false)
      assert.equal(entitlements.sponsoredWorkingEligible, true)
      assert.deepEqual([...entitlements.unlockedStyles], ['free'])
    })
  })

  it('production guard is wired through the real build flag', () => {
    const assets = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'features', 'styles', 'style-assets.ts'), 'utf8')
    assert.ok(assets.includes('import.meta.env.DEV'), 'dev detection must use the Vite build flag')
    const provider = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'AppProvider.tsx'), 'utf8')
    const uses = provider.match(/resolveDevStyleUnlock\(\{ dev: isDevelopmentBuild\(\) \}\)/g) ?? []
    assert.equal(uses.length, 2, 'both provider call sites must pass the real build flag')
    assert.ok(!provider.includes('resolveDevStyleUnlock()'), 'no unguarded call site may remain')
  })

  it('tier asset files exist on disk with real extensions', () => {
    for (const file of [
      'starkiconmagma.png',
      'starkwordmagma.png',
      'fullstarkmagma.png',
      'starkiconfrost.png',
      'starkwordfrost.png',
      'fullstarkfrost.png',
      'starkiconvoid.png',
      'starkwordvoid.png',
      'fullstarkvoid.png'
    ]) {
      const full = join(process.cwd(), 'src', 'public', file)
      assert.ok(existsSync(full), `src/public/${file} must exist`)
      assert.ok(statSync(full).size > 0, `src/public/${file} must be non-empty`)
    }
    for (const entry of STARK_STYLES) {
      for (const name of [entry.iconFile, entry.wordmarkFile, entry.fullLogoFile]) {
        assert.ok(existsSync(join(process.cwd(), 'src', 'public', name)), `registry file ${name} must exist on disk`)
      }
    }
  })
})
