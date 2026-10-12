import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessAgentProviders } from './extension-agent-compatibility'

function manifest(contributes: Record<string, unknown> | null, overrides = {}) {
  return {
    namespace: 'example',
    name: 'agent',
    version: '1.0.0',
    displayName: 'Example Agent',
    contributes,
    ...overrides
  }
}

describe('agent compatibility detection (contribution-driven)', () => {
  it('maps chat participants with contributed commands to eligible providers', () => {
    const found = assessAgentProviders(
      manifest({
        commands: [{ command: 'example.runAgent', title: 'Run agent' }],
        chatParticipants: [{ id: 'chat', name: 'Chat', fullName: 'Example Chat', command: 'example.runAgent' }]
      })
    )
    assert.equal(found.length, 1)
    assert.equal(found[0]?.providerId, 'chat')
    assert.equal(found[0]?.displayName, 'Example Chat')
    assert.equal(found[0]?.command, 'example.runAgent')
    assert.equal(found[0]?.eligible, true)
    assert.equal(found[0]?.reason, null)
  })

  it('marks participants without a contributed command unavailable (never faked)', () => {
    const found = assessAgentProviders(
      manifest({
        commands: [{ command: 'example.other', title: 'Other' }],
        chatParticipants: [{ id: 'chat', name: 'Chat', command: 'example.missing' }]
      })
    )
    assert.equal(found.length, 1)
    assert.equal(found[0]?.eligible, false)
    assert.equal(found[0]?.command, null)
    assert.ok((found[0]?.reason ?? '').includes('compatible agent command'))
  })

  it('non-agent extensions yield zero candidates (formatter/linter/theme never targets)', () => {
    const formatter = assessAgentProviders(manifest({ commands: [{ command: 'fmt.run', title: 'Format' }] }))
    assert.deepEqual(formatter, [])
    const languages = assessAgentProviders(manifest({ languages: [{ id: 'w lang' }] }))
    assert.deepEqual(languages, [])
    const themes = assessAgentProviders(manifest({ themes: [{ id: 'dark', label: 'Dark' }] }))
    assert.deepEqual(themes, [])
    const none = assessAgentProviders(manifest(null))
    assert.deepEqual(none, [])
  })

  it('never infers agency from names (agent-sounding name, no contributions)', () => {
    const found = assessAgentProviders(
      manifest({ commands: [{ command: 'x.run', title: 'Run' }] }, { name: 'super-agent-pro', displayName: 'Super Agent Pro' })
    )
    assert.deepEqual(found, [])
  })

  it('recognizes contributions under boring names (signal, not branding)', () => {
    const found = assessAgentProviders(
      manifest(
        {
          commands: [{ command: 'plain.run', title: 'Run' }],
          chatParticipants: [{ id: 'helper', name: 'Helper', command: 'plain.run' }]
        },
        { name: 'plain-helper', displayName: 'Plain Helper' }
      )
    )
    assert.equal(found.length, 1)
    assert.equal(found[0]?.eligible, true)
  })

  it('bounds and dedupes participants deterministically', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, command: 'plain.run' }))
    const found = assessAgentProviders(
      manifest({ commands: [{ command: 'plain.run', title: 'Run' }], chatParticipants: many })
    )
    assert.ok(found.length <= 8, 'provider candidates stay bounded')
    const dupes = assessAgentProviders(
      manifest({
        commands: [{ command: 'plain.run', title: 'Run' }],
        chatParticipants: [
          { id: 'chat', name: 'Chat', command: 'plain.run' },
          { id: 'chat', name: 'Chat Again', command: 'plain.run' }
        ]
      })
    )
    assert.equal(dupes.length, 1, 'duplicate participant ids collapse')
  })
})
