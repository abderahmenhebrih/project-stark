import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_AGENT_TARGET,
  DEFAULT_STARK_EFFORT,
  KILO_ADAPTER_ID,
  KILO_DISPLAY_NAME,
  STARK_EFFORT_LABELS,
  STARK_EFFORT_TOOLTIPS,
  STARK_EFFORTS,
  emptyKiloUnavailable,
  isStarkEffort,
  isStarkTarget,
  normalizeStarkEffort,
  parseStarkSlashOverride,
  resolveStarkSendMode,
  type KiloAvailability
} from './types'

describe('agent target contracts', () => {
  it('defaults to the STARK target', () => {
    assert.deepEqual(DEFAULT_AGENT_TARGET, { kind: 'stark' })
    assert.ok(isStarkTarget(DEFAULT_AGENT_TARGET))
    assert.ok(!isStarkTarget({ kind: 'external', adapterId: KILO_ADAPTER_ID }))
  })

  it('exposes Kilo as the first external adapter without inventing a logo', () => {
    assert.equal(KILO_ADAPTER_ID, 'kilo-code')
    assert.equal(KILO_DISPLAY_NAME, 'Kilo Code')
  })

  it('builds honest unavailable Kilo states with a concise reason', () => {
    const availability: KiloAvailability = emptyKiloUnavailable('Kilo bridge not available')
    assert.equal(availability.status, 'unavailable')
    assert.equal(availability.reason, 'Kilo bridge not available')
    assert.equal(availability.version, null)
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
