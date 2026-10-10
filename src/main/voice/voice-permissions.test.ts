import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideMediaPermission } from '../windows/voice-permissions'

describe('microphone permission policy', () => {
  it('grants audio-only media requests', () => {
    assert.equal(decideMediaPermission('media', ['audio']), true)
  })

  it('denies camera, screen capture, and every other permission', () => {
    assert.equal(decideMediaPermission('media', ['video']), false)
    assert.equal(decideMediaPermission('media', ['audio', 'video']), false)
    assert.equal(decideMediaPermission('camera', ['audio']), false)
    assert.equal(decideMediaPermission('screen', ['screen']), false)
    assert.equal(decideMediaPermission('microphone', ['audio']), false)
    assert.equal(decideMediaPermission('media', []), false)
    assert.equal(decideMediaPermission('media', undefined), false)
    assert.equal(decideMediaPermission('', ['audio']), false)
  })

  it('fails closed for unexpected media types', () => {
    assert.equal(decideMediaPermission('media', ['AUDIO']), false)
    assert.equal(decideMediaPermission('media', ['microphone']), false)
  })

  it('wires audio-only permissions into the app window', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const windowSource = readFileSync(join(process.cwd(), 'src', 'main', 'windows', 'app-window.ts'), 'utf8')
    assert.ok(windowSource.includes('configureMicrophonePermissions'), 'window installs the microphone policy')
    const policy = readFileSync(join(process.cwd(), 'src', 'main', 'windows', 'voice-permissions.ts'), 'utf8')
    assert.ok(policy.includes('setPermissionRequestHandler'), 'policy uses the secure permission architecture')
    assert.ok(policy.includes("['audio']"), 'policy grants audio only')
  })
})
