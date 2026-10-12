import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Generic target-architecture guarantees (§27 A + G):
 * - STARK is built-in; extension targets are data-driven coordinates.
 * - No vendor names appear in the target model, the registry, the
 *   composer, or the discovery API — no SessionPanel vendor branches.
 */

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

/** Vendor identifiers that must never structure product code. */
const VENDOR_TOKENS: readonly RegExp[] = [
  /kilocode/i,
  /kilo-code/i,
  /kilo code/i,
  /\bkilo\b/i,
  /\bcline\b/i,
  /copilot/i,
  /roo-code/i,
  /roo code/i
]

function assertNoVendors(source: string, file: string): void {
  for (const token of VENDOR_TOKENS) {
    assert.ok(!token.test(source), `${file} must not reference vendors (${token})`)
  }
}

describe('generic target model (no vendor union)', () => {
  it('declares STARK plus data-driven extension coordinates', () => {
    const types = readSource('src', 'shared', 'agent-target', 'types.ts')
    assert.ok(types.includes("kind: 'stark'"), 'STARK must stay built-in')
    assert.ok(types.includes("kind: 'extension'"), 'extension targets must exist')
    assert.ok(types.includes('extensionId: string'), 'extension identity must be data')
    assert.ok(types.includes('providerId: string'), 'provider identity must be data')
    assert.ok(!types.includes("'external'"), 'the old vendor-adapter shape must be gone')
    assert.ok(!types.includes('adapterId'), 'the old adapter-id shape must be gone')
    assertNoVendors(types, 'shared/agent-target/types.ts')
  })

  it('keeps the provider contract vendor-free', () => {
    const types = readSource('src', 'shared', 'extension-agents', 'types.ts')
    assert.ok(types.includes('ExtensionAgentProviderInfo'), 'provider rows must exist')
    assert.ok(types.includes('extensionId: string'), 'provider identity must be data')
    assertNoVendors(types, 'shared/extension-agents/types.ts')
  })

  it('keeps the registry, compatibility, service, and errors vendor-free', () => {
    const dir = join(process.cwd(), 'src', 'main', 'extension-agents')
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) {
        continue
      }
      assertNoVendors(readFileSync(join(dir, entry), 'utf8'), `main/extension-agents/${entry}`)
    }
  })

  it('SessionPanel carries no vendor branch', () => {
    const panel = readSource('src', 'renderer', 'src', 'features', 'sessions', 'SessionPanel.tsx')
    assertNoVendors(panel, 'SessionPanel.tsx')
    assert.ok(!panel.includes("'external'"), 'the old external-adapter branch must be gone')
    assert.ok(panel.includes("kind: 'extension'"), 'sends must route on the generic extension kind')
    assert.ok(panel.includes('findProvider(providers,'), 'selection must resolve data coordinates')
    assert.ok(panel.includes('No compatible agent extensions installed'), 'empty registry must read honestly')
  })

  it('composer state and discovery API stay vendor-free', () => {
    assertNoVendors(
      readSource('src', 'renderer', 'src', 'features', 'sessions', 'agent-target-state.ts'),
      'agent-target-state.ts'
    )
    assertNoVendors(
      readSource('src', 'renderer', 'src', 'lib', 'extension-agents-api.ts'),
      'extension-agents-api.ts'
    )
    const chrome = readSource('src', 'renderer', 'src', 'layouts', 'AppChrome.tsx')
    assertNoVendors(chrome, 'AppChrome.tsx')
    // The effort fallback lives on the docked Usage sidebar (the old
    // popover is gone); it must stay generic, never vendor-shaped.
    const sidebar = readSource('src', 'renderer', 'src', 'layouts', 'UsageSidebar.tsx')
    assertNoVendors(sidebar, 'UsageSidebar.tsx')
    assert.ok(sidebar.includes('Managed by extension'), 'effort fallback must be generic')
  })
})
