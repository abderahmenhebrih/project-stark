import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_AGENT_TARGET,
  DEFAULT_STARK_EFFORT,
  STARK_EFFORT_LABELS,
  STARK_EFFORT_TOOLTIPS,
  STARK_EFFORTS,
  agentTargetKey,
  isExtensionTarget,
  isStarkEffort,
  isStarkTarget,
  normalizeStarkEffort,
  parseStarkSlashOverride,
  resolveStarkSendMode
} from './types'

describe('agent target contracts', () => {
  it('defaults to the STARK target', () => {
    assert.deepEqual(DEFAULT_AGENT_TARGET, { kind: 'stark' })
    assert.ok(isStarkTarget(DEFAULT_AGENT_TARGET))
    assert.ok(!isExtensionTarget(DEFAULT_AGENT_TARGET))
  })

  it('models extension targets as data (no vendor union)', () => {
    const target = { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' } as const
    assert.ok(isExtensionTarget(target))
    assert.ok(!isStarkTarget(target))
    assert.equal(agentTargetKey(target), 'extension:example.agent:chat')
    assert.equal(agentTargetKey({ kind: 'stark' }), 'stark')
    // The type carries coordinates, not vendor names: any extension
    // identity fits the same shape.
    const other = { kind: 'extension', extensionId: 'other.helper', providerId: 'assistant' } as const
    assert.equal(agentTargetKey(other), 'extension:other.helper:assistant')
  })

  it('carries no vendor names in the target model', () => {
    const source = JSON.stringify(DEFAULT_AGENT_TARGET) + agentTargetKey({ kind: 'stark' })
    for (const vendor of ['kilo', 'cline', 'copilot', 'roo-code', 'roo code']) {
      assert.ok(!source.toLowerCase().includes(vendor), `target model must not name ${vendor}`)
    }
  })
})

describe('stark effort levels', () => {
  it('declares exactly five levels in ascending order', () => {
    assert.deepEqual([...STARK_EFFORTS], ['light', 'regular', 'medium', 'high', 'xhigh'])
    assert.equal(DEFAULT_STARK_EFFORT, 'regular')
  })

  it('labels every level with the required concise copy', () => {
    assert.deepEqual({ ...STARK_EFFORT_LABELS }, {
      light: 'Light',
      regular: 'Regular',
      medium: 'Medium',
      high: 'High',
      xhigh: 'XHigh'
    })
    assert.deepEqual({ ...STARK_EFFORT_TOOLTIPS }, {
      light: 'Fastest',
      regular: 'Balanced',
      medium: 'More reasoning',
      high: 'Deeper reasoning',
      xhigh: 'Maximum quality'
    })
  })

  it('validates and normalizes effort values fail-closed to Regular', () => {
    assert.ok(isStarkEffort('light') && isStarkEffort('xhigh'))
    assert.ok(!isStarkEffort('turbo') && !isStarkEffort('') && !isStarkEffort(null))
    assert.equal(normalizeStarkEffort('high'), 'high')
    assert.equal(normalizeStarkEffort('bogus'), 'regular')
    assert.equal(normalizeStarkEffort(undefined), 'regular')
  })
})

describe('composer slash overrides', () => {
  it('parses the three explicit internal overrides', () => {
    assert.deepEqual(parseStarkSlashOverride('/ask what is this?'), { mode: 'ask', content: 'what is this?' })
    assert.deepEqual(parseStarkSlashOverride('/work fix the bug'), { mode: 'work', content: 'fix the bug' })
    assert.deepEqual(parseStarkSlashOverride('/propose refactor this'), { mode: 'propose', content: 'refactor this' })
    assert.deepEqual(parseStarkSlashOverride('  /ASK case-insensitive'), { mode: 'ask', content: 'case-insensitive' })
  })

  it('ignores bare prefixes, unknown commands, and plain text', () => {
    assert.equal(parseStarkSlashOverride('/ask'), null)
    assert.equal(parseStarkSlashOverride('/ask   '), null)
    assert.equal(parseStarkSlashOverride('/deploy everything'), null)
    assert.equal(parseStarkSlashOverride('just a question'), null)
    assert.equal(parseStarkSlashOverride(''), null)
  })

  it('resolves normal sends to the unified Work path', () => {
    assert.deepEqual(resolveStarkSendMode('how does this work?'), { mode: 'work', content: 'how does this work?' })
    assert.deepEqual(resolveStarkSendMode('add a button'), { mode: 'work', content: 'add a button' })
    assert.deepEqual(resolveStarkSendMode('/ask explicit question'), { mode: 'ask', content: 'explicit question' })
  })
})
