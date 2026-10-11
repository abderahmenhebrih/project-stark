import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * LoopLink roster layout: side-by-side Brain/Heart tables showing the
 * FULL plan roster with toggles, drag grips, section labels, and the
 * limit dialog. Structure asserted against source (single shared
 * component); semantics run through model-roster.test.ts.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readModels(relative: string): string {
  return readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', ...relative.split('/'))
}

describe('roster layout', () => {
  it('Brain and Heart share one roster component in a side-by-side grid', () => {
    const page = readModels('ModelsSettings.tsx')
    assert.ok(page.includes('models-looplinks'), 'chains must sit in a shared grid')
    assert.ok(page.includes('<BrainChain'), 'grid must hold Brain')
    assert.ok(page.includes('<HeartChain'), 'grid must hold Heart')
    const css = readModels('models/ModelsSettings.css')
    const grid = css.match(/\.models-looplinks\s*\{[^}]*\}/)
    assert.ok(grid !== null && grid[0].includes('1fr'), 'grid must split two equal columns on desktop')
    assert.ok(css.includes('@media'), 'narrow widths must stack the tables')
  })

  it('roster derives enabled-first rows from active ids (no second truth source)', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('deriveModelRoster(library, chain)'), 'rows must derive from catalog + active ids')
    assert.ok(!chain.includes('useState') || chain.includes('deriveModelRoster'), 'no row-boolean store may exist')
  })

  it('one row per roster entry with drag/model/access/enabled columns', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('<table'), 'roster must render a table')
    for (const header of ['Model', 'Access', 'Enabled']) {
      assert.ok(chain.includes(header), `header must label ${header}`)
    }
    assert.ok(!chain.includes('models-chain__node'), 'no card tiles may remain')
  })

  it('drag grips exist only on enabled rows (no up/down buttons, no X)', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('models-chain__grip'), 'enabled rows must expose a drag handle')
    assert.ok(chain.includes('Reorder ${name}'), 'grip must announce the model')
    assert.ok(chain.includes('draggable'), 'enabled rows must be draggable')
    assert.ok(!chain.includes('Move ${name} up'), 'no visible up buttons may remain')
    assert.ok(!chain.includes('Move ${name} down'), 'no visible down buttons may remain')
    assert.ok(!chain.includes('Remove ${name}'), 'no X/remove controls may remain')
  })

  it('switches carry explicit accessible names with correct checked state', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('role="switch"'), 'toggles must use the switch role')
    assert.ok(chain.includes('Enable ${name} in ${label}'), 'enable must name model and LoopLink')
    assert.ok(chain.includes('Disable ${name} in ${label}'), 'disable must name model and LoopLink')
    assert.ok(chain.includes('aria-checked'), 'checked state must be exposed')
  })

  it('limit dialog offers switch-with and upgrade-plan with safe navigation', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('LoopLink limit reached'), 'dialog title must exist')
    assert.ok(chain.includes('role="dialog"'), 'dialog must use the dialog role')
    assert.ok(chain.includes('Switch model'), 'switch flow must exist')
    assert.ok(chain.includes('Upgrade plan'), 'upgrade flow must exist')
    assert.ok(chain.includes('props.onNavigateBilling()'), 'upgrade must route to Billing')
    assert.ok(!chain.includes('checkout'), 'dialog must not start checkout')
  })

  it('header reads active/available counts with the plan limit (never the old full copy)', () => {
    const chain = readModels('models/ModelChain.tsx')
    assert.ok(chain.includes('active /'), 'header must read active/available')
    assert.ok(chain.includes('limit:'), 'header must carry the plan limit')
    assert.ok(!chain.includes('chain is full'), 'old full-chain footer copy must be gone')
  })
})
