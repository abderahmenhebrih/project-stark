import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KILO_ADAPTER_ID, KILO_DISPLAY_NAME } from '../../shared/agent-target/types'
import { ExternalAgentRegistry, type ExternalAgentAdapter } from './external-agent'
import { KiloCodeAdapter, hasKiloExtension, parseKiloVersion, probeKiloCliVersion } from './kilo-bridge'

describe('kilo extension detection (pure)', () => {
  it('recognizes compatible Kilo extension coordinates', () => {
    assert.ok(hasKiloExtension([{ namespace: 'kilocode', name: 'kilo-code' }]))
    assert.ok(hasKiloExtension([{ namespace: 'other', name: 'x' }, { namespace: 'kilo-code', name: 'kilo-code' }]))
  })

  it('rejects unrelated extensions', () => {
    assert.ok(!hasKiloExtension([]))
    assert.ok(!hasKiloExtension([{ namespace: 'kilocode', name: 'kilo-helper' }]))
    assert.ok(!hasKiloExtension([{ namespace: 'open-vsx', name: 'kilo-code-theme' }]))
  })

  it('parses kilo --version output without executing anything', () => {
    assert.equal(parseKiloVersion('kilo version 1.2.3\n'), '1.2.3')
    assert.equal(parseKiloVersion('v2.0.0-beta'), '2.0.0-beta')
    assert.equal(parseKiloVersion('no version here'), null)
    assert.equal(parseKiloVersion(''), null)
  })
})

describe('kilo CLI probe (bounded, main-owned)', () => {
  it('fails closed to null for a missing binary (no throw, no hang)', async () => {
    const started = Date.now()
    const version = await probeKiloCliVersion({ timeoutMs: 1500 })
    // Either null (no Kilo CLI on PATH — the expected lab state) or a
    // parsed version when a real Kilo CLI exists. Never throws.
    assert.ok(version === null || /^\d+\.\d+\.\d+/.test(version))
    assert.ok(Date.now() - started < 10000, 'probe must stay bounded')
  })
})

describe('kilo adapter honesty + write safety', () => {
  it('registers under the stable adapter id with read-only capabilities', () => {
    const registry = new ExternalAgentRegistry()
    const adapter = new KiloCodeAdapter({ listInstalled: [], probeCli: async () => null })
    registry.register(adapter)
    assert.deepEqual(registry.ids(), [KILO_ADAPTER_ID])
    assert.equal(adapter.id, KILO_ADAPTER_ID)
    assert.equal(adapter.displayName, KILO_DISPLAY_NAME)
    assert.equal(adapter.capabilities.readOnly, true)
  })

  it('reports unavailable with a concise reason when no backend is installed', async () => {
    const adapter = new KiloCodeAdapter({ listInstalled: [], probeCli: async () => null })
    const availability = await adapter.availability()
    assert.equal(availability.status, 'unavailable')
    assert.equal(availability.reason, 'Kilo bridge not available')
    assert.equal(availability.version, null)
  })

  it('stays unavailable with the write-safety blocker even when a backend exists', async () => {
    const adapter = new KiloCodeAdapter({
      listInstalled: [{ namespace: 'kilocode', name: 'kilo-code' }],
      probeCli: async () => '1.2.3'
    })
    const availability = await adapter.availability()
    // A backend surface without a proven proposal-only mechanism must
    // NOT become selectable: live workspace writes stay forbidden.
    assert.equal(availability.status, 'unavailable')
    assert.ok((availability.reason ?? '').includes('no safe proposal-only mechanism'))
  })

  it('startRun refuses instead of faking Kilo output', async () => {
    const adapter = new KiloCodeAdapter({ listInstalled: [], probeCli: async () => null })
    const faced: ExternalAgentAdapter = adapter
    await assert.rejects(
      faced.startRun({ workspaceId: 1, sessionId: 1, prompt: 'hello' }),
      /Kilo bridge not available/
    )
  })

  it('exposes no live-workspace write authority', () => {
    const adapter = new KiloCodeAdapter() as unknown as Record<string, unknown>
    for (const forbidden of ['writeFile', 'applyEdit', 'executeCommand', 'spawn', 'exec', 'shell']) {
      assert.ok(!(forbidden in adapter), `adapter must not expose ${forbidden}`)
    }
  })

  it('sanitizes renderer state: availability carries no tokens, env, or URLs', async () => {
    const adapter = new KiloCodeAdapter({ listInstalled: [], probeCli: async () => null })
    const availability = await adapter.availability()
    const serialized = JSON.stringify(availability)
    assert.ok(!/token|secret|key|env|url|http/i.test(serialized), 'availability must carry no sensitive material')
    assert.deepEqual(Object.keys(availability).sort(), ['reason', 'status', 'version'])
  })
})
