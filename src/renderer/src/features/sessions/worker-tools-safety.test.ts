import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('worker-tool renderer safety', () => {
  it('approval card renders exact action as inert text with Deny/Approve only', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const start = panel.indexOf('STARK Worker needs permission')
    assert.ok(start >= 0, 'approval card must exist')
    const slice = panel.slice(start, start + 6000)
    assert.ok(slice.includes('This approval applies only to this exact action.'))
    assert.ok(slice.includes('Deny'))
    assert.ok(slice.includes('Approve'))
    assert.ok(!slice.includes('Always allow'))
    assert.ok(!slice.includes('Allow for session'))
    assert.ok(!slice.includes('Trust Worker'))
    assert.ok(!slice.includes('Remember'))
  })

  it('has no generic execute endpoint or editable approval args', () => {
    const api = readRenderer('lib/worker-tools-api.ts')
    assert.ok(!api.includes('execute'))
    assert.ok(!api.includes('callTool'))
    assert.ok(!api.includes('readFileAsAgent'))
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('Approve command'))
  })

  it('run details surface tool events without provider-native IDs', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    // Approval + work-run reload paths exist; no response/thread IDs leak.
    assert.ok(panel.includes('loadPendingApproval'))
    assert.ok(!panel.includes('previous_response_id'))
    assert.ok(!panel.includes('responseId'))
  })

  it('renders file/search/git content as inert text', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('dangerouslySetInnerHTML'))
    const api = readRenderer('lib/worker-tools-api.ts')
    assert.ok(!api.includes('innerHTML'))
  })

  it('performs no approval polling or timers', () => {
    const api = readRenderer('lib/worker-tools-api.ts')
    assert.ok(!api.includes('setInterval'))
    assert.ok(!api.includes('setTimeout'))
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const start = panel.indexOf('loadPendingApproval')
    assert.ok(start >= 0)
  })
})
