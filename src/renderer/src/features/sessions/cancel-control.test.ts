import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Composer Cancel control guarantees: a clear Cancel control exists
 * only while an AI operation is in flight, requests session-scoped
 * cancellation through the narrow bridge helper, and changes nothing
 * else about the composer (no redesign, no new authority).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('composer cancel control', () => {
  it('exposes a narrow cancel helper through the AI bridge', () => {
    const api = readRenderer('lib/providers-api.ts')
    assert.ok(api.includes('export function cancelAiOperation(request: AiCancelOperationRequest)'), 'helper takes a workspace/session reference only')
    assert.ok(api.includes('ai.cancelOperation'), 'helper must use the narrow cancel bridge function')
    assert.ok(api.includes('AiCancelOperationRequest'), 'request type must be the shared contract')
    assert.ok(api.includes('AiCancelOperationResult'), 'result type must be the shared contract')
  })

  it('shows Cancel while an AI operation is in flight or parked for approval', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('aria-label="Cancel AI operation"'), 'Cancel control must be labelled')
    assert.ok(panel.includes('handleCancel'), 'Cancel control must have a dedicated handler')
    assert.ok(panel.includes('cancelAiOperation'), 'handler must use the narrow helper')
    const gate = panel.slice(panel.indexOf('const cancellable'), panel.indexOf('async function handleCancel'))
    for (const state of ['state.sending', 'state.generating', 'proposal.preparing', 'work.preparing', 'pendingApproval']) {
      assert.ok(gate.includes(state), `Cancel visibility must consider ${state}`)
    }
  })

  it('cancel while parked clears the approval card via reload (never optimistic)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const handler = panel.slice(panel.indexOf('async function handleCancel'), panel.indexOf('async function handleCancel') + 1200)
    assert.ok(handler.includes('loadPendingApproval'), 'parked cancel must reload the pending approval')
  })

  it('cancel requests never decide authority in the renderer', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const handler = panel.slice(panel.indexOf('async function handleCancel'), panel.indexOf('async function handleCancel') + 800)
    assert.ok(handler.includes('cancelAiOperation'), 'handler must delegate to main')
    assert.ok(!handler.includes('abort()'), 'renderer must not own abort controllers')
    assert.ok(!handler.includes('dispatch('), 'cancel needs no optimistic renderer state')
  })
})
