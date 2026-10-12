import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExtensionAgentRegistry, isRegisteredAgentProvider } from './extension-agent-registry'

function record(overrides = {}) {
  return {
    extensionId: 'example.agent',
    namespace: 'example',
    name: 'agent',
    version: '1.0.0',
    providerId: 'chat',
    displayName: 'Example Agent',
    command: 'example.runAgent',
    capabilities: { chat: true, streaming: false, tools: false, proposals: true, cancellation: false },
    ...overrides
  }
}

describe('extension agent registry (data-driven)', () => {
  it('registers one fake compatible extension and lists it back', () => {
    const registry = new ExtensionAgentRegistry()
    assert.equal(registry.size(), 0)
    registry.register(record())
    assert.equal(registry.size(), 1)
    const found = registry.get('example.agent', 'chat')
    assert.equal(found?.displayName, 'Example Agent')
    assert.equal(found?.command, 'example.runAgent')
  })

  it('unregister removes the row; other extensions are untouched', () => {
    const registry = new ExtensionAgentRegistry()
    registry.register(record())
    registry.register(record({ extensionId: 'other.helper', namespace: 'other', name: 'helper', providerId: 'assistant', displayName: 'Other', command: 'other.run' }))
    assert.equal(registry.size(), 2)
    assert.ok(registry.unregisterProvider('example.agent', 'chat'))
    assert.equal(registry.size(), 1)
    assert.equal(registry.get('other.helper', 'assistant')?.displayName, 'Other')
    assert.equal(registry.unregisterForExtension('other.helper'), 1)
    assert.equal(registry.size(), 0)
  })

  it('two providers from separate extensions coexist', () => {
    const registry = new ExtensionAgentRegistry()
    registry.register(record())
    registry.register(record({ extensionId: 'second.bot', namespace: 'second', name: 'bot', displayName: 'Second' }))
    registry.register(record({ extensionId: 'example.agent', providerId: 'second-brain', displayName: 'Example Second', command: 'example.runSecond' }))
    assert.equal(registry.size(), 3)
    const ids = registry.list().map((entry) => `${entry.extensionId}::${entry.providerId}`).sort()
    assert.deepEqual(ids, ['example.agent::chat', 'example.agent::second-brain', 'second.bot::chat'])
  })

  it('re-registration replaces (extension update path)', () => {
    const registry = new ExtensionAgentRegistry()
    registry.register(record())
    registry.register(record({ version: '1.1.0', displayName: 'Example Agent v2' }))
    assert.equal(registry.size(), 1)
    assert.equal(registry.get('example.agent', 'chat')?.version, '1.1.0')
  })

  it('rejects malformed registrations fail-closed', () => {
    const registry = new ExtensionAgentRegistry()
    for (const bad of [
      null,
      {},
      record({ command: '' }),
      record({ providerId: 'has\0nul' }),
      record({ capabilities: { chat: 'yes' } }),
      record({ extensionId: '' })
    ]) {
      assert.throws(() => registry.register(bad as never), /not valid/)
    }
    assert.equal(registry.size(), 0)
  })

  it('carries no vendor names (generic coordinates only)', () => {
    assert.ok(isRegisteredAgentProvider(record()))
    const serialized = JSON.stringify(registrySnapshot())
    for (const vendor of ['kilo', 'cline', 'copilot']) {
      assert.ok(!serialized.toLowerCase().includes(vendor), `registry must not name ${vendor}`)
    }
  })
})

function registrySnapshot(): unknown {
  const registry = new ExtensionAgentRegistry()
  registry.register(record())
  return registry.list()
}
