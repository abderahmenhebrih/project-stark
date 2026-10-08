import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyRecoveryDraft,
  initialRecoveryPanelState,
  recoveryDraftFromConfig,
  recoveryPanelReducer,
  recoverySourceCopy,
  recoveryTargetCopy,
  type RecoveryPanelState
} from './recovery-state'

describe('recovery panel state', () => {
  it('starts empty in off with no autosave surface', () => {
    const state = initialRecoveryPanelState()
    assert.equal(state.workspaceId, null)
    assert.equal(state.draft.mode, 'off')
    assert.equal(state.saving, false)
    assert.equal(state.event, null)
  })

  it('loads config into draft without persisting', () => {
    let state: RecoveryPanelState = { ...initialRecoveryPanelState(), workspaceId: 1 }
    state = recoveryPanelReducer(state, { type: 'config-loaded', workspaceId: 1, config: null })
    assert.equal(state.draft.mode, 'off')
    state = recoveryPanelReducer(state, {
      type: 'config-loaded',
      workspaceId: 1,
      config: { mode: 'auto_once', ask: { providerId: 'openai', model: 'a' }, brain: { providerId: 'openai', model: 'b' }, worker: { providerId: 'openai', model: 'w' } }
    })
    assert.equal(state.draft.mode, 'auto_once')
    assert.equal(state.draft.ask.model, 'a')
  })

  it('mode toggle edits draft only', () => {
    let state: RecoveryPanelState = { ...initialRecoveryPanelState(), workspaceId: 7 }
    state = recoveryPanelReducer(state, { type: 'mode-selected', workspaceId: 7, mode: 'handoff' })
    assert.equal(state.draft.mode, 'handoff')
    assert.equal(state.config, null)
    state = recoveryPanelReducer(state, { type: 'mode-selected', workspaceId: 7, mode: 'auto_once' })
    assert.equal(state.draft.mode, 'auto_once')
  })

  it('draft edits and save lifecycle with workspace isolation', () => {
    let state: RecoveryPanelState = { ...initialRecoveryPanelState(), workspaceId: 3 }
    state = recoveryPanelReducer(state, { type: 'draft-edited', workspaceId: 3, field: { scope: 'ask' }, providerId: 'openai', model: 'r-ask' })
    assert.equal(state.draft.ask.model, 'r-ask')
    // Cross-workspace outcomes rejected.
    const ignored = recoveryPanelReducer(state, { type: 'draft-edited', workspaceId: 999, field: { scope: 'ask' }, providerId: 'openai', model: 'evil' })
    assert.equal(ignored.draft.ask.model, 'r-ask')
    state = recoveryPanelReducer(state, { type: 'save-started', workspaceId: 3 })
    assert.equal(state.saving, true)
    state = recoveryPanelReducer(state, {
      type: 'save-succeeded',
      workspaceId: 3,
      config: { mode: 'handoff', ask: { providerId: 'openai', model: 'r-ask' }, brain: null, worker: null }
    })
    assert.equal(state.saving, false)
    assert.equal(state.notice, 'Recovery configuration saved.')
  })

  it('save failure surfaces without autosave', () => {
    let state: RecoveryPanelState = { ...initialRecoveryPanelState(), workspaceId: 4, saving: true, draft: emptyRecoveryDraft() }
    state = recoveryPanelReducer(state, { type: 'save-failed', workspaceId: 4, message: 'We couldn’t save the recovery configuration.' })
    assert.equal(state.saving, false)
    assert.ok((state.saveError ?? '').includes('couldn'))
  })

  it('source copy covers all statuses with no percentages or countdowns', () => {
    for (const status of ['handoff_ready', 'running', 'succeeded', 'failed', 'dismissed', 'interrupted'] as const) {
      const copy = recoverySourceCopy(status)
      assert.ok(copy.length > 0)
      assert.ok(!copy.includes('%'))
      assert.ok(!copy.toLowerCase().includes('countdown'))
      assert.ok(!copy.toLowerCase().includes('retrying'))
    }
    assert.ok(recoverySourceCopy('handoff_ready').includes('created a recovery session'))
    assert.ok(recoverySourceCopy('failed').includes('No further automatic'))
  })

  it('target banner includes failure, policy, status with no credentials', () => {
    const copy = recoveryTargetCopy({
      id: 1,
      workspaceId: 1,
      sourceSessionId: 2,
      targetSessionId: 3,
      sourceMessageId: 4,
      looplinkHandoffId: 5,
      operation: 'ask',
      failureCategory: 'provider-rate-limit',
      policyMode: 'auto_once',
      status: 'succeeded',
      attemptCount: 1,
      targetUserMessageId: 6,
      targetAssistantMessageId: 7,
      targetRunId: null,
      routes: [{ role: 'ask', providerId: 'openai', model: 'r' }],
      createdAt: 1,
      updatedAt: 2,
      completedAt: 3
    })
    assert.ok(copy.includes('provider-rate-limit'))
    assert.ok(copy.includes('Auto once'))
    assert.ok(!copy.toLowerCase().includes('key'))
  })

  it('draft from config preserves nulls as blanks', () => {
    const draft = recoveryDraftFromConfig({ mode: 'off', ask: null, brain: null, worker: null })
    assert.equal(draft.ask.model, '')
    assert.equal(draft.mode, 'off')
  })

  it('workspace change resets recovery view', () => {
    const state = recoveryPanelReducer({ ...initialRecoveryPanelState(), workspaceId: 1 }, { type: 'workspace-changed', workspaceId: 2 })
    assert.equal(state.workspaceId, 2)
    assert.equal(state.event, null)
  })
})
