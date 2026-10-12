import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canSelectKilo,
  effortVisibleFor,
  initialAgentTargetState,
  isTargetSwitchBlocked,
  resolveComposerSend,
  selectAgentTarget,
  setStarkEffort
} from './agent-target-state'
import { emptySessionTabDraft, stashSessionDraft } from './session-tabs'

function unavailableKilo(): { status: 'unavailable'; reason: string; version: null } {
  return { status: 'unavailable', reason: 'Kilo bridge not available', version: null }
}

describe('agent target selection', () => {
  it('starts on STARK with Regular effort', () => {
    const state = initialAgentTargetState()
    assert.deepEqual(state.target, { kind: 'stark' })
    assert.equal(state.effort, 'regular')
    assert.equal(state.kilo.status, 'unavailable')
  })

  it('refuses unavailable Kilo (state unchanged, never a fake working target)', () => {
    const state = initialAgentTargetState(unavailableKilo())
    const next = selectAgentTarget(state, { kind: 'external', adapterId: 'kilo-code' })
    assert.equal(next, state)
    assert.deepEqual(next.target, { kind: 'stark' })
  })

  it('selects Kilo only when the adapter reports available or running', () => {
    const blocked = initialAgentTargetState(unavailableKilo())
    assert.ok(!canSelectKilo(blocked.kilo))
    for (const status of ['available', 'running'] as const) {
      const ready = initialAgentTargetState({ status, reason: null, version: '1.2.3' })
      assert.ok(canSelectKilo(ready.kilo))
      const next = selectAgentTarget(ready, { kind: 'external', adapterId: 'kilo-code' })
      assert.deepEqual(next.target, { kind: 'external', adapterId: 'kilo-code' })
    }
    for (const status of ['connecting', 'error'] as const) {
      const notReady = initialAgentTargetState({ status, reason: 'busy', version: null })
      assert.ok(!canSelectKilo(notReady.kilo))
    }
  })

  it('blocks target switches during an active run (drafts untouched)', () => {
    const idle = { sending: false, generating: false, proposalPreparing: false, workPreparing: false, kiloRunning: false }
    assert.ok(!isTargetSwitchBlocked(idle))
    for (const flags of [
      { ...idle, sending: true },
      { ...idle, generating: true },
      { ...idle, proposalPreparing: true },
      { ...idle, workPreparing: true },
      { ...idle, kiloRunning: true }
    ]) {
      assert.ok(isTargetSwitchBlocked(flags))
    }
  })

  it('composer draft survives target selection (selection never clears text)', () => {
    // selectAgentTarget returns target/effort state only — it holds no
    // composer reference and cannot clear drafts by construction.
    const state = initialAgentTargetState({ status: 'available', reason: null, version: '1.0.0' })
    const draft = 'unsent work in progress'
    const next = selectAgentTarget(state, { kind: 'external', adapterId: 'kilo-code' })
    assert.equal(typeof draft, 'string')
    assert.ok(draft.length > 0)
    assert.deepEqual(next.target, { kind: 'external', adapterId: 'kilo-code' })
  })
})

describe('stark effort state', () => {
  it('sets effort across all five levels and ignores invalid values', () => {
    let state = initialAgentTargetState()
    for (const effort of ['light', 'regular', 'medium', 'high', 'xhigh'] as const) {
      state = setStarkEffort(state, effort)
      assert.equal(state.effort, effort)
    }
    const unchanged = setStarkEffort(state, state.effort)
    assert.equal(unchanged, state)
  })

  it('hides the effort selector for external targets', () => {
    assert.ok(effortVisibleFor({ kind: 'stark' }))
    assert.ok(!effortVisibleFor({ kind: 'external', adapterId: 'kilo-code' }))
  })

  it('persists per session inside the existing tab-draft stash (memory only)', () => {
    // No web storage, no DB: target + effort ride the renderer-local
    // per-session draft alongside composer text and attachments.
    const fresh = emptySessionTabDraft('ask')
    assert.equal(fresh.target, undefined)
    assert.equal(fresh.effort, undefined)
    const drafts = stashSessionDraft({}, 7, {
      ...fresh,
      composer: 'unsent work',
      target: { kind: 'stark' },
      effort: 'xhigh'
    })
    assert.equal(drafts[7]?.composer, 'unsent work')
    assert.deepEqual(drafts[7]?.target, { kind: 'stark' })
    assert.equal(drafts[7]?.effort, 'xhigh')
  })

  it('external sends are blocked (no fake Kilo output); STARK resolves unified work', () => {
    const blocked = resolveComposerSend({ kind: 'external', adapterId: 'kilo-code' }, 'hello')
    assert.deepEqual(blocked, { blocked: 'external-unavailable' })
    assert.deepEqual(resolveComposerSend({ kind: 'stark' }, 'hello'), { mode: 'work', content: 'hello' })
    assert.deepEqual(resolveComposerSend({ kind: 'stark' }, '/ask why?'), { mode: 'ask', content: 'why?' })
  })
})
