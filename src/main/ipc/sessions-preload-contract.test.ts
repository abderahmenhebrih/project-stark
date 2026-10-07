import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static sessions bridge contract: the preload source must expose
 * exactly the four fixed session functions and must never gain raw
 * capabilities or an assistant-writing path. (The providers/AI
 * namespaces live beside it under their own contract.)
 * Runs against the repository source (cwd is the repo root via npm).
 */
function readPreloadSource(): string {
  const file = join(process.cwd(), 'src', 'preload', 'index.ts')
  assert.ok(existsSync(file), 'preload source must exist')
  return readFileSync(file, 'utf8')
}

describe('sessions preload contract', () => {
  it('exposes only sessions.create/list/listMessages/sendUserMessage', () => {
    const source = readPreloadSource()
    for (const expected of [
      'IPC_CHANNELS.sessionsCreate',
      'IPC_CHANNELS.sessionsList',
      'IPC_CHANNELS.sessionsListMessages',
      'IPC_CHANNELS.sessionsSendUserMessage',
      'createSessionsApi',
      'sessions: createSessionsApi()'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
  })

  it('exposes no assistant-writing or arbitrary-role path', () => {
    const source = readPreloadSource()
    for (const forbidden of ['sendAssistant', 'send-assistant', 'insert-any-role', 'role:']) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('exposes no raw capabilities', () => {
    const source = readPreloadSource()
    for (const forbidden of [
      'DatabaseSync',
      'CodingSessionRepository',
      'CodingSessionService',
      'coding_sessions',
      'coding_messages',
      'SELECT',
      'INSERT',
      'node:sqlite',
      'fetch(',
      'WebSocket',
      'apiKey',
      'decrypt',
      'model:complete',
      'chat:run',
      'child_process'
    ]) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('uses no raw channel strings for sessions', () => {
    const source = readPreloadSource()
    assert.ok(!source.includes("'stark:sessions:"), 'preload must not hardcode session channel names')
  })

  it('service and IPC sources offer no assistant channel', () => {
    const ipcSource = readFileSync(join(process.cwd(), 'src', 'main', 'ipc', 'sessions.ts'), 'utf8')
    for (const forbidden of ['sendAssistant', 'send-assistant', 'insert-any-role']) {
      assert.ok(!ipcSource.includes(forbidden), `session IPC must not contain ${forbidden}`)
    }
    const serviceSource = readFileSync(
      join(process.cwd(), 'src', 'main', 'sessions', 'coding-session-service.ts'),
      'utf8'
    )
    assert.ok(!serviceSource.includes('sendAssistantMessage'), 'service must not offer assistant writes')
  })
})
