import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OrchestrationRun } from '../../../../shared/orchestration/types'
import { initialWorkPanelState, workPanelReducer, type WorkPanelState } from './work-state'

function fakeRun(id = 11, status: OrchestrationRun['status'] = 'completed'): OrchestrationRun {
  return {
    id,
    workspaceId: 7,
    sessionId: 3,
    userMessageId: 21,
    status,
    action: 'delegate',
    planSummary: 'Needs analysis.',
    finalMessageId: 22,
    errorCategory: null,
    createdAt: 1000,
    updatedAt: 1000,
    steps: [
      { id: 1, runId: id, ordinal: 0, kind: 'brain_plan', status: 'completed', instruction: null, output: 'Needs analysis.', createdAt: 1000, updatedAt: 1000, modelAudit: { role: 'brain', providerId: 'openai', model: 'model-A', routeKey: 'primary', requestedProfile: null } },
      { id: 2, runId: id, ordinal: 1, kind: 'worker', status: 'completed', instruction: 'Analyze.', output: 'analysis', createdAt: 1000, updatedAt: 1000, modelAudit: { role: 'worker', providerId: 'openai', model: 'model-C', routeKey: 'coding', requestedProfile: 'coding' } },
      { id: 3, runId: id, ordinal: 2, kind: 'brain_synthesis', status: 'completed', instruction: null, output: null, createdAt: 1000, updatedAt: 1000, modelAudit: { role: 'brain', providerId: 'openai', model: 'model-A', routeKey: 'primary', requestedProfile: null } }
    ]
  }
}

function bound(): WorkPanelState {
  return { ...initialWorkPanelState(), workspaceId: 7, sessionId: 3 }
}

describe('work panel state', () => {
  it('starts idle', () => {
    const state = bound()
    assert.equal(state.preparing, false)
    assert.equal(state.run, null)
    assert.equal(state.error, null)
  })

  it('run-started enters preparing without fake stages', () => {
    let state = bound()
    state = workPanelReducer(state, { type: 'run-started', workspaceId: 7, sessionId: 3 })
    assert.equal(state.preparing, true)
    assert.equal(state.run, null)
    // A duplicate start while preparing is ignored: no queue forms.
    assert.equal(workPanelReducer(state, { type: 'run-started', workspaceId: 7, sessionId: 3 }), state)
  })

  it('run-succeeded stores the persisted run with its real steps', () => {
    let state: WorkPanelState = { ...bound(), preparing: true }
    state = workPanelReducer(state, { type: 'run-succeeded', workspaceId: 7, sessionId: 3, run: fakeRun() })
    assert.equal(state.preparing, false)
    assert.deepEqual(
      state.run?.steps.map((step) => step.kind),
      ['brain_plan', 'worker', 'brain_synthesis']
    )
    assert.equal(state.run?.steps[1]?.output, 'analysis')
  })

  it('direct-answer runs carry a single plan step', () => {
    const direct: OrchestrationRun = { ...fakeRun(12), action: 'answer', steps: [fakeRun(12).steps[0] as OrchestrationRun['steps'][number]] }
    let state: WorkPanelState = { ...bound(), preparing: true }
    state = workPanelReducer(state, { type: 'run-succeeded', workspaceId: 7, sessionId: 3, run: direct })
    assert.equal(state.run?.steps.length, 1)
    assert.equal(state.run?.action, 'answer')
  })

  it('run-failed keeps the error with no fake message', () => {
    let state: WorkPanelState = { ...bound(), preparing: true }
    state = workPanelReducer(state, { type: 'run-failed', workspaceId: 7, sessionId: 3, message: 'boom' })
    assert.equal(state.preparing, false)
    assert.equal(state.error, 'boom')
    assert.equal(state.run, null)
  })

  it('explicit retry re-enters preparing; nothing retries automatically', () => {
    const idle: WorkPanelState = { ...bound(), error: 'boom' }
    assert.equal(idle.preparing, false)
    const retried = workPanelReducer(idle, { type: 'run-retried', workspaceId: 7, sessionId: 3 })
    assert.equal(retried.preparing, true)
    assert.equal(retried.error, null)
  })

  it('runs-loaded restores persistent details after restart', () => {
    let state = bound()
    state = workPanelReducer(state, { type: 'runs-loaded', workspaceId: 7, sessionId: 3, run: fakeRun() })
    assert.equal(state.run?.id, 11)
    // Loading never disturbs an active flight.
    const flying: WorkPanelState = { ...bound(), preparing: true }
    assert.equal(workPanelReducer(flying, { type: 'runs-loaded', workspaceId: 7, sessionId: 3, run: fakeRun() }), flying)
  })

  it('workspace and session switches reset transient work state', () => {
    const active: WorkPanelState = { ...bound(), run: fakeRun(), error: 'e' }
    const moved = workPanelReducer(active, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(moved.workspaceId, 8)
    assert.equal(moved.run, null)
    assert.equal(moved.error, null)
    const reselected = workPanelReducer(active, { type: 'session-changed', workspaceId: 7, sessionId: 4 })
    assert.equal(reselected.sessionId, 4)
    assert.equal(reselected.run, null)
  })

  it('ignores cross-workspace and cross-session outcomes', () => {
    const state: WorkPanelState = { ...bound(), preparing: true }
    assert.equal(workPanelReducer(state, { type: 'run-started', workspaceId: 8, sessionId: 3 }), state)
    assert.equal(
      workPanelReducer(state, { type: 'run-failed', workspaceId: 7, sessionId: 9, message: 'x' }),
      state
    )
  })

  it('dismiss clears the run without side effects', () => {
    const state: WorkPanelState = { ...bound(), run: fakeRun() }
    const next = workPanelReducer(state, { type: 'run-dismissed', workspaceId: 7, sessionId: 3 })
    assert.equal(next.run, null)
    assert.equal(next.preparing, false)
  })
})
