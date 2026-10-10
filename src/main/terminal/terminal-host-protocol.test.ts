import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildTerminalHostMessage,
  buildTerminalHostPayloadMessage,
  parseTerminalHostMessage,
  parseTerminalHostPayloadMessage,
  parseTerminalMainPayloadMessage,
  TERMINAL_HOST_MAX_MESSAGE_BYTES,
  TERMINAL_HOST_PROTOCOL,
  TERMINAL_HOST_TO_MAIN_TYPES,
  TERMINAL_MAIN_TO_HOST_TYPES
} from './terminal-host-protocol'

/**
 * Terminal Host protocol: closed vocabularies on both sides, bounded
 * envelopes, and schema validation that rejects malformed, unknown,
 * or oversized messages without replying.
 */
describe('terminal host protocol', () => {
  it('declares the closed narrow vocabulary', () => {
    assert.deepEqual([...TERMINAL_MAIN_TO_HOST_TYPES].sort(), ['CREATE', 'KILL', 'RESIZE', 'SHUTDOWN', 'WRITE'].sort())
    assert.deepEqual(
      [...TERMINAL_HOST_TO_MAIN_TYPES].sort(),
      ['CREATE_FAILED', 'CREATED', 'DATA', 'EXIT', 'KILL_RESULT', 'READY', 'SHUTDOWN_COMPLETE'].sort()
    )
    assert.equal(TERMINAL_HOST_PROTOCOL, 'stark-terminal-host/v1')
  })

  it('bootstrap mirrors the same vocabulary', () => {
    const bootstrap = readFileSync(join(process.cwd(), 'src', 'main', 'terminal', 'terminal-host-bootstrap.js'), 'utf8')
    for (const type of ['READY', 'SHUTDOWN_COMPLETE', 'CREATE', 'KILL']) {
      assert.ok(bootstrap.includes(type), `bootstrap must name ${type}`)
    }
    assert.ok(bootstrap.includes('terminal-host.mjs'), 'bootstrap must load the owned runtime module')
    assert.ok(bootstrap.includes('node-pty'), 'bootstrap must resolve the PTY backend beside the artifacts')
    assert.ok(!bootstrap.includes('extension-host/'), 'bootstrap must never reference Extension Host modules')
    assert.ok(!bootstrap.includes('generic-host'), 'bootstrap must never reference the generic host')
    const runtime = readFileSync(join(process.cwd(), 'src', 'main', 'terminal', 'terminal-host.mjs'), 'utf8')
    for (const type of [...TERMINAL_MAIN_TO_HOST_TYPES, ...TERMINAL_HOST_TO_MAIN_TYPES]) {
      assert.ok(runtime.includes(`'${type}'`), `runtime must name ${type}`)
    }
  })

  it('validates control envelopes and rejects the rest', () => {
    assert.equal(parseTerminalHostMessage({ protocol: TERMINAL_HOST_PROTOCOL, type: 'READY' }), 'READY')
    assert.equal(parseTerminalHostMessage({ protocol: TERMINAL_HOST_PROTOCOL, type: 'SHUTDOWN_COMPLETE' }), 'SHUTDOWN_COMPLETE')
    assert.equal(parseTerminalHostMessage({ protocol: 'other/v1', type: 'READY' }), null)
    assert.equal(parseTerminalHostMessage({ protocol: TERMINAL_HOST_PROTOCOL, type: 'SPAWN_ANYTHING' }), null)
    assert.equal(parseTerminalHostMessage(null), null)
    assert.equal(parseTerminalHostMessage('READY'), null)
    assert.equal(buildTerminalHostMessage('SHUTDOWN').protocol, TERMINAL_HOST_PROTOCOL)
  })

  it('validates host payloads with schemas and bounds', () => {
    const created = { protocol: TERMINAL_HOST_PROTOCOL, type: 'CREATED', payload: { requestId: 'r1', sessionId: 's1' } }
    assert.deepEqual(parseTerminalHostPayloadMessage(created), { type: 'CREATED', payload: { requestId: 'r1', sessionId: 's1' } })
    assert.equal(parseTerminalHostPayloadMessage({ ...created, payload: { requestId: '', sessionId: 's1' } }), null)
    const kill = { protocol: TERMINAL_HOST_PROTOCOL, type: 'KILL_RESULT', payload: { requestId: 'r1', sessionId: 's1', outcome: 'initiated' } }
    assert.deepEqual(parseTerminalHostPayloadMessage(kill), { type: 'KILL_RESULT', payload: { requestId: 'r1', sessionId: 's1', outcome: 'initiated' } })
    assert.equal(
      parseTerminalHostPayloadMessage({ ...kill, payload: { requestId: 'r1', sessionId: 's1', outcome: 'nuked' } }),
      null
    )
    const big = { protocol: TERMINAL_HOST_PROTOCOL, type: 'DATA', payload: { sessionId: 's1', data: 'x'.repeat(TERMINAL_HOST_MAX_MESSAGE_BYTES + 1) } }
    assert.equal(parseTerminalHostPayloadMessage(big), null)
    assert.equal(parseTerminalHostPayloadMessage({ protocol: TERMINAL_HOST_PROTOCOL, type: 'WHATEVER', payload: {} }), null)
  })

  it('validates main payloads on the host gate', () => {
    const create = {
      protocol: TERMINAL_HOST_PROTOCOL,
      type: 'CREATE',
      payload: { requestId: 'r1', sessionId: 's1', cwd: 'C:\\x', shellFile: 'powershell.exe', shellArgs: ['-NoLogo'], cols: 80, rows: 24, env: {} }
    }
    const parsed = parseTerminalMainPayloadMessage(create)
    assert.ok(parsed !== null && parsed.type === 'CREATE')
    assert.equal(parseTerminalMainPayloadMessage({ ...create, payload: { ...create.payload, shellFile: '' } }), null)
    assert.equal(parseTerminalMainPayloadMessage({ ...create, payload: { ...create.payload, cols: 0 } }), null)
    const kill = { protocol: TERMINAL_HOST_PROTOCOL, type: 'KILL', payload: { requestId: 'r1', sessionId: 's1' } }
    assert.deepEqual(parseTerminalMainPayloadMessage(kill), { type: 'KILL', payload: { requestId: 'r1', sessionId: 's1' } })
    assert.equal(parseTerminalMainPayloadMessage({ ...kill, payload: { requestId: 'r1' } }), null)
  })

  it('builds typed main payloads', () => {
    const built = buildTerminalHostPayloadMessage('KILL', { requestId: 'r1', sessionId: 's1' })
    assert.equal(built.protocol, TERMINAL_HOST_PROTOCOL)
    assert.equal(built.type, 'KILL')
  })
})
