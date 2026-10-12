import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Professional icon-pack guarantees (Lucide).
 *
 * One pack for all renderer-owned generic UI glyphs. Exclusions hold:
 * STARK brand assets, official AI/model/provider icons, extension
 * artwork, file-type assets, and Monaco/xterm internals are untouched.
 */
function root(): string {
  return process.cwd()
}

function readRenderer(relative: string): string {
  const file = join(root(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function rendererTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      rendererTsxFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('lucide icon pack', () => {
  it('uses exactly one professional pack (lucide-react), tree-shaken', () => {
    const icons = readRenderer('components/icons/UiIcon.tsx')
    assert.ok(icons.includes("from 'lucide-react'"), 'UI icons must come from lucide-react')
    assert.ok(!icons.includes('import *'), 'no namespace bundle import (tree-shaken named imports only)')
    assert.ok(!icons.includes('dynamic import') && !icons.includes('import('), 'no runtime icon loading')
    assert.ok(!icons.includes('fetch(') && !icons.includes('http'), 'no remote runtime icon fetches')
    const pkg = JSON.parse(readFileSync(join(root(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    assert.ok(typeof pkg.dependencies['lucide-react'] === 'string', 'lucide-react must be a declared dependency')
    for (const rival of ['@fortawesome', 'react-icons', 'heroicons', '@heroicons', '@mui/icons', 'material-icons']) {
      assert.ok(
        !Object.keys(pkg.dependencies).some((name) => name.includes(rival)),
        `no second icon library (${rival})`
      )
    }
  })

  it('covers every generic renderer UI glyph', () => {
    const icons = readRenderer('components/icons/UiIcon.tsx')
    for (const name of [
      'menu', 'explorer', 'search', 'plugins', 'git', 'extensions', 'terminal',
      'settings', 'usage', 'live', 'context', 'review', 'plus', 'more', 'close',
      'chevron-down', 'chevron-right', 'chevron-left', 'arrow-up', 'refresh',
      'mic', 'paperclip', 'check', 'info', 'warning', 'error'
    ]) {
      assert.ok(icons.includes(`'${name}'`) || icons.includes(`"${name}"`), `icon set must include ${name}`)
    }
  })

  it('leaves no StarkIcon call sites in product surfaces', () => {
    const files = rendererTsxFiles(join(root(), 'src', 'renderer', 'src'))
    const offenders = files.filter((file) => {
      if (file.endsWith('StarkIcon.tsx')) {
        return false
      }
      return readFileSync(file, 'utf8').includes('<StarkIcon')
    })
    assert.deepEqual(offenders, [], `all product call sites must use UiIcon: ${offenders.join(', ')}`)
  })

  it('keeps official brand, model, and extension artwork untouched', () => {
    const brand = readRenderer('components/brandAssets.ts')
    assert.ok(brand.includes('starkiconmagma.png'), 'Magma brand assets must stay')
    assert.ok(brand.includes('fullstarkmagma.png'), 'Magma lockup must stay')
    const modelIcons = readRenderer('features/settings/sections/models/model-icons.ts')
    assert.ok(modelIcons.includes('openai'), 'official provider/model icons must stay')
    const icons = readRenderer('components/icons/UiIcon.tsx')
    assert.ok(!icons.includes('starkicon') && !icons.includes('model-icons'), 'UI pack must not restyle brand/model art')
  })

  it('preserves accessibility labels on icon-only buttons', () => {
    const icons = readRenderer('components/icons/UiIcon.tsx')
    assert.ok(icons.includes('aria-hidden'), 'decorative icons must hide from assistive tech')
    assert.ok(icons.includes('aria-label'), 'meaningful icons must keep labels')
    for (const file of ['layouts/AppChrome.tsx', 'features/sessions/SessionPanel.tsx']) {
      const source = readRenderer(file)
      assert.ok(!source.includes('<UiIcon name="search" size={22} />\n        </button>') || source.includes('aria-label="Search workspace"'), `${file} icon buttons must stay labelled`)
    }
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('aria-label="Usage status"'), 'Usage button must be labelled')
    assert.ok(chrome.includes('aria-label="Open Live Review"'), 'Live Review button must be labelled')
  })

  it('keeps consistent stroke sizing (compact 16 / normal 18 / toolbar 20-22)', () => {
    const icons = readRenderer('components/icons/UiIcon.tsx')
    assert.ok(icons.includes('strokeWidth'), 'stroke width must be consistent from one place')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('size={22}'), 'toolbar icons stay at the established 22px')
  })
})
