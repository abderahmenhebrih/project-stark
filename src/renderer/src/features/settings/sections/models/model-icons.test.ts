import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FREE_CATALOG_COUNT, deriveModelLibrary } from './model-library'
import { initialProviderPanelState } from '../../../sessions/provider-state'

/**
 * Official model icon registry: verified first-party provider marks,
 * one shared mapping, provenance manifest, sanitized assets. Mapping
 * behavior is proven against repository source plus on-disk assets
 * (the registry module carries Vite asset imports, unrunnable under
 * plain Node — same precedent as brand-assets).
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readModels(relative: string): string {
  return readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', ...relative.split('/'))
}

function iconsDir(): string {
  return join(process.cwd(), 'src', 'public', 'model-icons')
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

/** Retired generated-artwork filenames that must never be referenced again. */
const RETIRED_GENERATED = [
  'muse-spark-13.svg', 'muse-spark-12.svg', 'deepseek-v41.svg', 'deepseek-v4.svg',
  'gpt-luna.svg', 'mimo-pro.svg', 'mimo-flash.svg', 'nemotron.svg', 'gemini.svg',
  'claude.svg', 'kimi.svg', 'minimax.svg', 'mistral.svg', 'longcat.svg', 'glm.svg',
  'fallback.svg'
]

describe('model icon registry', () => {
  it('all 15 Free model IDs map to a local asset (none missing, none extra)', () => {
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

  it('no mapping uses a remote URL at runtime (offline by construction)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(!registry.includes('http://') && !registry.includes('https://'), 'registry must contain no remote URLs')
  })

  it('Claude Haiku 5.5 resolves to the official orange Claude mark (not the Anthropic logo)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(registry.includes("'builtin:claude-haiku-5.5': claudeIcon"), 'Claude model must map to the Claude icon')
    assert.ok(!registry.includes('anthropic.png') && !registry.includes('anthropicIcon'), 'no Anthropic-logo reference may remain')
  })

  it('unknown model IDs resolve to the fallback (never broken/empty)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(registry.includes('MODEL_FALLBACK_ICON'), 'a generic fallback must exist')
    assert.ok(
      registry.includes('MODEL_ICON_BY_ID[stableId] ?? MODEL_FALLBACK_ICON'),
      'unknown ids must resolve to the fallback'
    )
  })

  it('related models share the verified provider mark (no manufactured variation)', () => {
    const registry = readModels('models/model-icons.ts')
    assert.ok(registry.includes("'builtin:deepseek-v4.1-flash': deepseekIcon"))
    assert.ok(registry.includes("'builtin:deepseek-v4-flash': deepseekIcon"))
    assert.ok(registry.includes("'builtin:mimo-v2.6-pro': xiaomiIcon"))
    assert.ok(registry.includes("'builtin:mimo-v2.6-flash': xiaomiIcon"))
    assert.ok(registry.includes("'builtin:muse-spark-1.3': metaIcon"))
    assert.ok(registry.includes("'builtin:muse-spark-1.2': metaIcon"))
  })

  it('no retired generated artwork remains referenced', () => {
    const registry = readModels('models/model-icons.ts')
    for (const retired of RETIRED_GENERATED) {
      assert.ok(!registry.includes(retired), `generated asset ${retired} must not be referenced`)
    }
    const onDisk = readdirSync(iconsDir()).filter((name) => name.endsWith('.svg'))
    assert.deepEqual(onDisk, ['zai.svg'], 'only the verified first-party zai.svg may remain as SVG')
  })
})

describe('model icon provenance manifest', () => {
  it('manifest exists and covers every non-fallback asset with an official source', () => {
    const manifest = readModels('models/model-icon-sources.md')
    for (const file of ['openai.png', 'google.png', 'claude.png', 'deepseek.png', 'mistral.png', 'nvidia.png', 'kimi.jpg', 'minimax.jpg', 'xiaomi.png', 'meta.png', 'longcat.png', 'zai.svg']) {
      assert.ok(manifest.includes(file), `manifest must document ${file}`)
    }
    assert.ok(manifest.includes('github.com/'), 'manifest must record official org sources')
    assert.ok(!manifest.includes('pinimg') && !manifest.includes('seeklogo'), 'manifest must show no scraper sources')
  })
})

describe('model icon assets on disk', () => {
  it('raster assets are real decodable images: correct magic, square, bounded', () => {
    const dir = iconsDir()
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.png'))) {
      const path = join(dir, file)
      const bytes = readFileSync(path)
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a real PNG`)
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      assert.equal(width, height, `${file} must be square`)
      // Official first-party sources ship small favicon-grade marks
      // (e.g. 48px); 48px is the floor so official assets are never
      // resampled or rejected for their published size.
      assert.ok(width >= 48, `${file} must be usable source (≥48px)`)
      assert.ok(statSync(path).size < 100 * 1024, `${file} must stay under 100KB`)
    }
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.jpg'))) {
      const path = join(dir, file)
      const bytes = readFileSync(path)
      assert.equal(bytes[0], 0xff, `${file} must be a real JPEG`)
      assert.equal(bytes[1], 0xd8, `${file} must be a real JPEG`)
      assert.ok(statSync(path).size < 100 * 1024, `${file} must stay under 100KB`)
    }
  })

  it('SVG assets pass sanitization (no script, no remote refs, no handlers)', () => {
    const dir = iconsDir()
    const svgs = readdirSync(dir).filter((name) => name.endsWith('.svg'))
    assert.ok(svgs.length >= 1, 'downloaded SVG assets must be checked')
    for (const file of svgs) {
      const content = readFileSync(join(dir, file), 'utf8')
      assert.ok(!content.includes('<script'), `${file} must contain no script`)
      assert.ok(!content.includes('javascript:'), `${file} must contain no script URLs`)
      assert.ok(!content.includes('href="http'), `${file} must reference nothing remote`)
      assert.ok((content.match(/\son\w+\s*=/g) ?? []).length === 0, `${file} must contain no event handlers`)
      for (const tag of ['<iframe', '<object', '<embed']) {
        assert.ok(!content.includes(tag), `${file} must contain no ${tag}`)
      }
      assert.ok(content.includes('viewBox'), `${file} must be a scalable vector`)
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
})
