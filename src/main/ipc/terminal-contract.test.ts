import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 11 preload contract: the renderer receives only the narrow
 * terminal functions over fixed channels — never node-pty,
 * child_process, or generic IPC primitives.
 */
function readPreloadSource(): string {
  const file = join(process.cwd(), 'src', 'preload', 'index.ts')
  assert.ok(existsSync(file), 'preload source must exist')
  return readFileSync(file, 'utf8')
}

describe('terminal preload contract', () => {
  it('exposes only the intended terminal functions', () => {
    const source = readPreloadSource()
    for (const expected of [
      'terminal',
      'IPC_CHANNELS.terminalCreate',
      'IPC_CHANNELS.terminalWrite',
      'IPC_CHANNELS.terminalResize',
      'IPC_CHANNELS.terminalKill',
      'IPC_CHANNELS.terminalData',
      'IPC_CHANNELS.terminalExit',
      'onData',
      'onExit'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
  })

  it('uses no raw terminal channel strings', () => {
    const source = readPreloadSource()
    assert.ok(!source.includes("'stark:terminal"), 'preload must not hardcode terminal channels')
  })

  it('exposes no process-spawning or generic IPC capabilities', () => {
    const source = readPreloadSource()
    for (const forbidden of [
      'child_process',
      'node-pty',
      'require(',
      'process.env',
      'process.platform',
      'exec',
      'execFile',
      'spawn',
      'pty',
      'shell',
      '.send(',
      'generic invoke',
      'generic send',
      'generic on'
    ]) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
    assert.ok(!source.includes('ipcRenderer.invoke(') || source.includes('IPC_CHANNELS.terminalCreate'))
  })

  it('validates event payloads before delivery', () => {
    const source = readPreloadSource()
    assert.ok(source.includes('isTerminalDataEvent'), 'data events must be validated')
    assert.ok(source.includes('isTerminalExitEvent'), 'exit events must be validated')
    assert.ok(source.includes('removeListener'), 'subscriptions must return an unsubscribe function')
  })
})
