import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FREE_CATALOG_COUNT, deriveModelLibrary } from './model-library'
import { initialProviderPanelState } from '../../../sessions/provider-state'

/**
 * Model icons: distinct bundled local marks for the 15 Free models —
 * one registry shared by the library cards and both LoopLink rosters.
 * Offline, packaged, decorative (names carry meaning), with a safe
 * fallback. Follows the brand-assets precedent: the registry module
 * itself carries Vite asset imports (unrunnable under plain Node), so
 * mapping is proven against repository source plus on-disk assets —
 * no pixels asserted.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readModels(relative: string): string {
  return readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', ...relative.split('/'))
}

const EXPECTED_IDS = [
  'builtin:muse-spark-1.3',
  'builtin:glm-5.3-flash',
  'builtin:deepseek-v4.1-flash',
  'builtin:gpt-5.6-luna',
  'builtin:gemini-2.5-flash',
  'builtin:claude-haiku-5.5',
  'builtin:minimax-m3',
  'builtin:kimi-k2.7-code',
  'builtin:mimo-v2.6-pro',
  'builtin:mimo-v2.6-flash',
  'builtin:nemotron-3.5-lightning',
  'builtin:deepseek-v4-flash',
  'builtin:muse-spark-1.2',
  'builtin:longcat-2.0',
  'builtin:mistral-large-4'
]

describe('model icon registry', () => {
  it('all 15 Free model IDs map to a bundled icon (none missing, none extra)', () => {
    assert.equal(FREE_CATALOG_COUNT, 15)
    const registry = readModels('models/model-icons.ts')
    for (const stableId of EXPECTED_IDS) {
      assert.ok(registry.includes(`'${stableId}'`), `${stableId} must map to an icon`)
    }
    const mapped = registry.match(/'builtin:[a-z0-9.-]+':/g) ?? []
    assert.equal(mapped.length, 15, 'registry must map exactly the 15 Free ids')
  })

  it('registry keys match the live catalog order (no drift, no paid models)', () => {
    const library = deriveModelLibrary(initialProviderPanelState())
    const builtins = library.filter((entry) => entry.origin === 'built-in').map((entry) => entry.stableId)
    assert.deepEqual(builtins, EXPECTED_IDS)
  })

  it('no icon uses a remote http/https URL (offline by construction)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(!registry.includes('http://') && !registry.includes('https://'), 'registry must contain no remote URLs')
    assert.ok(registry.includes('.png'), 'icons must resolve to local raster assets')
    assert.ok(!registry.includes('.svg'), 'no minimalist glyph assets may remain')
  })

  it('unknown model IDs resolve to the fallback (never broken/empty)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(registry.includes('MODEL_FALLBACK_ICON'), 'a generic fallback must exist')
    assert.ok(
      registry.includes('MODEL_ICON_BY_ID[stableId] ?? MODEL_FALLBACK_ICON'),
      'unknown ids must resolve to the fallback'
    )
  })

  it('related models share family marks (no invented variants)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(registry.includes("'builtin:deepseek-v4.1-flash': deepseekV41Icon"))
    assert.ok(registry.includes("'builtin:deepseek-v4-flash': deepseekV4Icon"))
    assert.ok(registry.includes("'builtin:mimo-v2.6-pro': mimoProIcon"))
    assert.ok(registry.includes("'builtin:mimo-v2.6-flash': mimoFlashIcon"))
    assert.ok(registry.includes("'builtin:muse-spark-1.3': museSpark13Icon"))
    assert.ok(registry.includes("'builtin:muse-spark-1.2': museSpark12Icon"))
  })
})

/** Reads PNG dimensions from the IHDR chunk (no image decoder needed). */
function pngDimensions(path: string): { readonly width: number; readonly height: number } {
  const bytes = readFileSync(path)
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} must be a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('model icon assets on disk', () => {
  it('local raster assets exist at the expected build paths: square, sized, optimized', () => {
    const dir = join(process.cwd(), 'src', 'public', 'model-icons')
    assert.ok(existsSync(dir), 'src/public/model-icons must exist')
    const files = readdirSync(dir).filter((file) => file.endsWith('.png'))
    assert.ok(files.length >= 16, `at least 16 icons expected, found ${files.length}`)
    assert.ok(!readdirSync(dir).some((file) => file.endsWith('.svg')), 'no glyph SVGs may remain')
    for (const file of files) {
      const path = join(dir, file)
      assert.ok(statSync(path).size < 100 * 1024, `${file} must stay under 100KB`)
      const { width, height } = pngDimensions(path)
      assert.equal(width, height, `${file} must be square 1:1`)
      assert.ok(width >= 128, `${file} must be high-resolution source`)
    }
  })
})

describe('model icon integration', () => {
  it('Model Library cards use the central mapping (no generic placeholder)', () => {
    const card = readModels('models/ModelCard.tsx')
    assert.ok(card.includes('modelIconFor(model.stableId)'), 'cards must resolve icons by stable id')
    assert.ok(!card.includes('name="extensions"'), 'generic placeholder must be gone from cards')
    assert.ok(card.includes('alt=""'), 'icons must be decorative (names carry meaning)')
    assert.ok(card.includes('MODEL_FALLBACK_ICON'), 'load failures must fall back safely')
  })

  it('Brain/Heart roster rows use the same mapping (no duplicated asset logic)', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('modelIconFor(row.stableId)'), 'roster must resolve icons by stable id')
    assert.ok(!chain.includes('name="extensions"'), 'generic placeholder must be gone from the roster')
    assert.ok(chain.includes('alt=""'), 'roster icons must be decorative')
  })

  it('registry adds no runtime surface', () => {
    const registry = readModels('models/model-icons.ts')
    for (const fake of ['generateText', 'ProviderRegistry', 'fetch(', '.invoke(']) {
      assert.ok(!registry.includes(fake), `registry must not contain ${fake}`)
    }
  })

  it('images fill their containers (full-icon rendering, no tile-in-tile)', () => {
    const css = readModels('models/ModelsSettings.css')
    const card = css.match(/\.models-card__img\s*\{[^}]*\}/)
    assert.ok(card !== null && card[0].includes('object-fit: cover'), 'library images must fill the icon')
    assert.ok(card[0].includes('52px'), 'library icons must render large (~52px)')
    const row = css.match(/\.models-chain__img\s*\{[^}]*\}/)
    assert.ok(row !== null && row[0].includes('object-fit: cover'), 'roster images must fill the icon')
    assert.ok(row[0].includes('30px'), 'roster icons must render compact (~30px)')
  })
})
