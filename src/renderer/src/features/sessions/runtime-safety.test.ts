import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('runtime renderer safety', () => {
  it('approval card carries exact runtime action with warnings and Deny/Approve only', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const start = panel.indexOf('Capability: Project runtime')
    assert.ok(start >= 0, 'runtime approval variant must exist')
    const slice = panel.slice(start, start + 4000)
    assert.ok(slice.includes('This exact command will run with your user account from the Workspace root and may modify files, start subprocesses, or access the network.'))
    assert.ok(slice.includes('This runtime may remain active for up to 30 minutes.'))
    assert.ok(slice.includes('This approval applies only to this exact program, arguments, and preview port.'))
    assert.ok(!slice.includes('Always allow'))
    assert.ok(!slice.includes('Start automatically next time'))
    assert.ok(!slice.includes('Trust this script'))
    assert.ok(!slice.includes('Remember command'))
  })

  it('runtime surface has no countdown, polling, start bypass, or HTML sinks', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Maximum runtime: 30 minutes.'))
    assert.ok(!panel.includes('startRuntime'))
    assert.ok(!panel.includes('spawnRuntime'))
    assert.ok(!panel.includes('dangerouslySetInnerHTML'))
    const api = readRenderer('lib/runtimes-api.ts')
    assert.ok(!api.includes('setInterval'))
    assert.ok(!api.includes('setTimeout'))
    assert.ok(!api.includes('startRuntime'))
    assert.ok(!api.includes('spawnRuntime'))
    assert.ok(!api.includes('executeCommand'))
    assert.ok(!api.includes('runCommand'))
    assert.ok(!api.includes('innerHTML'))
  })

  it('runtime logs render as inert text with truncation copy', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Older runtime output was omitted.'))
    assert.ok(panel.includes('Runtime stdout'))
    assert.ok(panel.includes('Runtime stderr'))
    assert.ok(panel.includes('Open Preview'))
    assert.ok(panel.includes('Reload Preview'))
    assert.ok(panel.includes('Stop Runtime'))
  })
})
