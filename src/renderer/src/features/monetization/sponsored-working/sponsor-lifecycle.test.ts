import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAiRunId,
  createAiRunLifecycleStore,
  deriveAiRunState,
  isGenuinelyWorking,
  isTerminalRunState
} from './sponsor-lifecycle'
import { shouldShowSponsor } from './sponsor-viewability'
import { NullSponsorProvider, DevFixtureSponsorProvider, buildSponsorContext } from './sponsor-provider'
import { entitlementForPlan } from './sponsor-policy'

const FREE = entitlementForPlan('free')
const IDLE_FLAGS = {
  sending: false,
  generating: false,
  proposalPreparing: false,
  workPreparing: false,
  looplinkActing: false
}

function showFor(aiState: ReturnType<typeof deriveAiRunState>, visible = true, focused = true): boolean {
  const creative = new DevFixtureSponsorProvider().getCreative(buildSponsorContext())
  return shouldShowSponsor({
    entitlement: FREE,
    aiState,
    appVisible: visible,
    appFocused: focused,
    creative,
    frequencyCapExceeded: false
  })
}

describe('sponsor lifecycle', () => {
  it('idle maps to hidden', () => {
    assert.equal(deriveAiRunState(IDLE_FLAGS), 'idle')
    assert.equal(showFor('idle'), false)
  })

  it('genuine working states are eligible (thinking/working/tool-running/waiting-provider)', () => {
    assert.equal(deriveAiRunState({ ...IDLE_FLAGS, generating: true }), 'thinking')
    assert.equal(deriveAiRunState({ ...IDLE_FLAGS, workPreparing: true }), 'working')
    assert.equal(deriveAiRunState({ ...IDLE_FLAGS, proposalPreparing: true }), 'working')
    assert.equal(deriveAiRunState({ ...IDLE_FLAGS, looplinkActing: true }), 'tool-running')
    for (const state of ['thinking', 'working', 'tool-running', 'waiting-provider'] as const) {
      assert.equal(isGenuinelyWorking(state), true, `${state} must be genuinely working`)
      assert.equal(showFor(state), true, `${state} must be display-eligible`)
    }
  })

  it('queued send alone maps to queued (not sponsor eligible until real work)', () => {
    assert.equal(deriveAiRunState({ ...IDLE_FLAGS, sending: true }), 'queued')
    assert.equal(isGenuinelyWorking('queued'), false)
    assert.equal(showFor('queued'), false)
  })

  it('streaming is NOT sponsor eligible (attention belongs to the response)', () => {
    assert.equal(isGenuinelyWorking('streaming'), false)
    assert.equal(showFor('streaming'), false)
  })

  it('completed/failed/cancelled hide immediately', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      assert.equal(isTerminalRunState(state), true)
      assert.equal(showFor(state), false, `${state} must hide immediately`)
    }
  })

  it('hidden/background app hides and is not counted', () => {
    assert.equal(showFor('working', false, true), false)
    assert.equal(showFor('working', true, false), false)
  })

  it('returning to focus does not duplicate the run impression (ledger idempotent)', () => {
    const store = createAiRunLifecycleStore()
    const runId = buildAiRunId({ workspaceId: 7, sessionId: 2, generationRequestId: 3 })
    const seen: string[] = []
    const off = store.subscribe((event) => {
      seen.push(event.type)
    })
    store.runStarted(runId)
    store.runStateChanged(runId, 'working')
    store.runCompleted(runId)
    assert.deepEqual(seen, ['run-started', 'run-state-changed', 'run-completed'])
    assert.equal(store.getState(runId), 'completed')
    off()
  })

  it('lifecycle store never fabricates streaming/waiting-provider from current flags', () => {
    // Current single-invoke flights cannot report intermediate provider
    // stages, so the adapter only emits idle/queued/thinking/working/tool-running.
    const states = new Set([
      deriveAiRunState(IDLE_FLAGS),
      deriveAiRunState({ ...IDLE_FLAGS, sending: true }),
      deriveAiRunState({ ...IDLE_FLAGS, generating: true }),
      deriveAiRunState({ ...IDLE_FLAGS, workPreparing: true }),
      deriveAiRunState({ ...IDLE_FLAGS, looplinkActing: true })
    ])
    assert.ok(!states.has('streaming'))
    assert.ok(!states.has('waiting-provider'))
  })

  it('run id is the common correlation key and encodes no sensitive data', () => {
    const runId = buildAiRunId({ workspaceId: 7, sessionId: 2, generationRequestId: 3 })
    assert.match(runId, /^run-7-2-3$/)
    assert.ok(!runId.includes('prompt'))
  })

  it('null creative never shows even while working', () => {
    const creative = new NullSponsorProvider().getCreative(buildSponsorContext())
    assert.equal(
      shouldShowSponsor({
        entitlement: FREE,
        aiState: 'working',
        appVisible: true,
        appFocused: true,
        creative,
        frequencyCapExceeded: false
      }),
      false
    )
  })

  it('inference cost attribution accumulates per run without billing math', () => {
    const store = createAiRunLifecycleStore()
    const runId = buildAiRunId({ workspaceId: 1, sessionId: 1, generationRequestId: 1 })
    assert.equal(store.getInferenceCostMicros(runId), null)
    store.recordInferenceCost(runId, 'brain-model', 40)
    store.recordInferenceCost(runId, 'heart-model', 60)
    assert.equal(store.getInferenceCostMicros(runId), 100)
    store.recordInferenceCost(runId, 'bad', -5)
    assert.equal(store.getInferenceCostMicros(runId), 100)
  })
})
