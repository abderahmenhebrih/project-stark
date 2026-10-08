import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static session-context bridge contract: the preload source must
 * expose exactly the four fixed prepare functions and must never gain
 * raw filesystem, provider, or content-forging capabilities.
 * Runs against the repository source (cwd is the repo root via npm).
 */
function readPreloadSource(): string {
  const file = join(process.cwd(), 'src', 'preload', 'index.ts')
  assert.ok(existsSync(file), 'preload source must exist')
  return readFileSync(file, 'utf8')
}

describe('session context preload contract', () => {
  it('exposes only the four prepare functions', () => {
    const source = readPreloadSource()
    for (const expected of [
      'IPC_CHANNELS.sessionContextPrepareExcerpt',
      'IPC_CHANNELS.sessionContextPrepareFile',
      'IPC_CHANNELS.sessionContextPrepareSearchMatch',
      'IPC_CHANNELS.sessionContextPrepareNote',
      'createSessionContextApi',
      'sessionContext: createSessionContextApi()'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
  })

  it('exposes no content-forging or raw capabilities', () => {
    const source = readPreloadSource()
    for (const forbidden of [
      'sendAssistant',
      'node:fs',
      'node:path',
      'DatabaseSync',
      'message_context_items',
      'CodingSessionRepository',
      'SessionContextService',
      'fetch(',
      'WebSocket',
      'child_process'
    ]) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('uses no raw channel strings for session context', () => {
    const source = readPreloadSource()
    assert.ok(!source.includes("'stark:session-context:"), 'preload must not hardcode context channel names')
  })

  it('context IPC offers no send/exec/provider surface', () => {
    const ipcSource = readFileSync(join(process.cwd(), 'src', 'main', 'ipc', 'session-context.ts'), 'utf8')
    for (const forbidden of ['sendUserMessage', 'generateResponse', 'exec', 'spawn', 'provider']) {
      assert.ok(!ipcSource.includes(forbidden), `context IPC must not contain ${forbidden}`)
    }
  })
})
