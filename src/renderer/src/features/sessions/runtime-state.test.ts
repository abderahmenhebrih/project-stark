import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ProjectRuntimeSummary } from '../../../../shared/project-runtime/types'
import { initialRuntimePanelState, runtimePanelReducer, runtimeStatusLabel, type RuntimePanelState } from './runtime-state'

function fakeRuntime(id: number, status: ProjectRuntimeSummary['status'] = 'running'): ProjectRuntimeSummary {
  return {
    id,
    workspaceId: 1,
    program: 'npm',
    args: ['run', 'dev'],
    previewPort: 5173,
    previewUrl: 'http://127.0.0.1:5173/',
    status,
    exitCode: null,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
    logsTruncated: false,
    totalOutputBytes: 0,
    stopReason: null,
    createdAt: 10,
    startedAt: 11,
    endedAt: null
  }
}

describe('runtime panel state', () => {
  it('starts empty with no timers or polling surface', () => {
    const state = initialRuntimePanelState()
    assert.equal(state.workspaceId, null)
    assert.equal(state.active, null)
    assert.deepEqual(state.history, [])
    assert.equal(state.acting, false)
    assert.equal(state.error, null)
  })

  it('workspace change resets everything', () => {
    const loaded = runtimePanelReducer(
      { ...initialRuntimePanelState(), workspaceId: 1 },
      { type: 'active-loaded', workspaceId: 1, active: fakeRuntime(3) }
    )
    const switched = runtimePanelReducer(loaded, { type: 'workspace-changed', workspaceId: 2 })
    assert.equal(switched.workspaceId, 2)
    assert.equal(switched.active, null)
    assert.deepEqual(switched.history, [])
    assert.equal(switched.error, null)
  })

  it('loads active runtime and history explicitly', () => {
    let state: RuntimePanelState = { ...initialRuntimePanelState(), workspaceId: 1 }
    state = runtimePanelReducer(state, { type: 'active-loaded', workspaceId: 1, active: fakeRuntime(3) })
    assert.equal(state.active?.id, 3)
    state = runtimePanelReducer(state, { type: 'history-loaded', workspaceId: 1, history: [fakeRuntime(3, 'stopped')] })
    assert.equal(state.history.length, 1)
    assert.equal(state.history[0]?.status, 'stopped')
  })

  it('pushed updates replace the active runtime without touching history', () => {
    let state: RuntimePanelState = {
      ...initialRuntimePanelState(),
      workspaceId: 1,
      history: [fakeRuntime(2, 'stopped')]
    }
    state = runtimePanelReducer(state, { type: 'updated', workspaceId: 1, active: fakeRuntime(3) })
    assert.equal(state.active?.id, 3)
    assert.equal(state.history.length, 1)
    state = runtimePanelReducer(state, { type: 'updated', workspaceId: 1, active: null })
    assert.equal(state.active, null)
  })

  it('actions track acting state and surface failures safely', () => {
    let state: RuntimePanelState = { ...initialRuntimePanelState(), workspaceId: 1 }
    state = runtimePanelReducer(state, { type: 'action-started', workspaceId: 1 })
    assert.equal(state.acting, true)
    // Duplicate starts while acting are ignored (single flight).
    state = runtimePanelReducer(state, { type: 'action-started', workspaceId: 1 })
    assert.equal(state.acting, true)
    state = runtimePanelReducer(state, { type: 'action-succeeded', workspaceId: 1, active: null })
    assert.equal(state.acting, false)
    assert.equal(state.error, null)
    state = runtimePanelReducer(state, { type: 'action-started', workspaceId: 1 })
    state = runtimePanelReducer(state, { type: 'action-failed', workspaceId: 1, message: 'We couldn’t stop the project runtime.' })
    assert.equal(state.acting, false)
    assert.equal(state.error, 'We couldn’t stop the project runtime.')
    state = runtimePanelReducer(state, { type: 'error-dismissed', workspaceId: 1 })
    assert.equal(state.error, null)
  })

  it('ignores cross-workspace outcomes', () => {
    const state = { ...initialRuntimePanelState(), workspaceId: 1 }
    assert.equal(runtimePanelReducer(state, { type: 'active-loaded', workspaceId: 2, active: fakeRuntime(9) }).active, null)
    assert.equal(runtimePanelReducer(state, { type: 'updated', workspaceId: 2, active: fakeRuntime(9) }).active, null)
    assert.deepEqual(runtimePanelReducer(state, { type: 'history-loaded', workspaceId: 2, history: [fakeRuntime(9)] }).history, [])
    assert.equal(runtimePanelReducer(state, { type: 'action-failed', workspaceId: 2, message: 'x' }).error, null)
  })

  it('labels every lifecycle status without countdowns', () => {
    assert.equal(runtimeStatusLabel('starting'), 'Starting')
    assert.equal(runtimeStatusLabel('running'), 'Running')
    assert.equal(runtimeStatusLabel('stopped'), 'Stopped')
    assert.equal(runtimeStatusLabel('exited'), 'Exited')
    assert.equal(runtimeStatusLabel('timed_out'), 'Timed out')
    assert.equal(runtimeStatusLabel('spawn_failed'), 'Failed to start')
    assert.equal(runtimeStatusLabel('interrupted'), 'Interrupted')
  })
})
