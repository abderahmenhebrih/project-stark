import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildHostMessage,
  EXTENSION_HOST_MAX_FORMAT_MESSAGE_BYTES,
  EXTENSION_HOST_MAX_MESSAGE_BYTES,
  EXTENSION_HOST_PROTOCOL,
  HOST_TO_MAIN_TYPES,
  MAIN_TO_HOST_TYPES,
  parseHostMessage
} from './protocol'

describe('extension host protocol', () => {
  it('uses the closed vocabulary (lifecycle plus formatter pilot)', () => {
    assert.deepEqual([...MAIN_TO_HOST_TYPES], [
      'PING',
      'SHUTDOWN',
      'ACTIVATE_FORMATTER',
      'FORMAT_DOCUMENT',
      'DEACTIVATE_FORMATTER'
    ])
    assert.deepEqual([...HOST_TO_MAIN_TYPES], [
      'READY',
      'PONG',
      'HOST_ERROR',
      'SHUTDOWN_COMPLETE',
      'FORMATTER_READY',
      'FORMAT_RESULT',
      'FORMAT_ERROR',
      'FORMATTER_DEACTIVATED'
    ])
    assert.equal(EXTENSION_HOST_PROTOCOL, 'stark-extension-host/v1')
    assert.equal(EXTENSION_HOST_MAX_MESSAGE_BYTES, 64 * 1024)
    assert.equal(EXTENSION_HOST_MAX_FORMAT_MESSAGE_BYTES, 2 * 1024 * 1024)
  })

  it('accepts well-formed host messages', () => {
    assert.equal(parseHostMessage({ protocol: EXTENSION_HOST_PROTOCOL, type: 'READY' }), 'READY')
    assert.equal(parseHostMessage({ protocol: EXTENSION_HOST_PROTOCOL, type: 'PONG' }), 'PONG')
    assert.equal(
      parseHostMessage({ protocol: EXTENSION_HOST_PROTOCOL, type: 'SHUTDOWN_COMPLETE' }),
      'SHUTDOWN_COMPLETE'
    )
  })

  it('rejects malformed, unknown, and oversized messages', () => {
    for (const bad of [
      null,
      undefined,
      'READY',
      42,
      {},
      { protocol: EXTENSION_HOST_PROTOCOL },
      { type: 'READY' },
      { protocol: 'other/v1', type: 'READY' },
      { protocol: EXTENSION_HOST_PROTOCOL, type: 'EXEC' },
      { protocol: EXTENSION_HOST_PROTOCOL, type: 'ready' },
      { protocol: EXTENSION_HOST_PROTOCOL, type: 42 },
      { protocol: EXTENSION_HOST_PROTOCOL, type: 'READY', blob: 'x'.repeat(EXTENSION_HOST_MAX_MESSAGE_BYTES + 1) }
    ]) {
      assert.equal(parseHostMessage(bad), null)
    }
  })

  it('builds only main-to-host messages', () => {
    assert.deepEqual(buildHostMessage('PING'), { protocol: EXTENSION_HOST_PROTOCOL, type: 'PING' })
    assert.deepEqual(buildHostMessage('SHUTDOWN'), { protocol: EXTENSION_HOST_PROTOCOL, type: 'SHUTDOWN' })
  })

  it('bootstrap mirrors the same envelope, types, and cap', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'bootstrap.js'), 'utf8')
    assert.ok(source.includes(`'${EXTENSION_HOST_PROTOCOL}'`), 'bootstrap must use the same envelope')
    for (const type of MAIN_TO_HOST_TYPES) {
      assert.ok(source.includes(`'${type}'`), `bootstrap must route ${type}`)
    }
    // Host-to-main formatter replies travel opaquely through the
    // bootstrap (it never invents them); they must be named by the
    // STARK-owned formatter module that sends them.
    const formatter = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'formatter-host.mjs'), 'utf8')
    for (const type of ['FORMATTER_READY', 'FORMAT_RESULT', 'FORMAT_ERROR', 'FORMATTER_DEACTIVATED']) {
      assert.ok(formatter.includes(`'${type}'`), `formatter module must send ${type}`)
    }
    assert.ok(source.includes('64 * 1024'), 'bootstrap must enforce the same 64 KiB cap')
    for (const forbidden of ['require(', 'activationEvents', 'extension/', 'package.json', 'child_process', 'eval(']) {
      assert.ok(!source.includes(forbidden), `bootstrap must not contain ${forbidden}`)
    }
    // The single deliberate exception: one narrow dynamic module load
    // of the main-supplied STARK-owned formatter module. No static
    // import statement may appear (the entrypoint stays
    // dependency-free); extension contact lives only behind the
    // delegated module's own allowlist.
    assert.ok(!/^\s*import\s+(.+from\s+)?['"]/m.test(source), 'bootstrap must keep zero static imports')
    assert.ok(source.includes('formatterModuleUrl'), 'formatter module URL must come from the main payload only')
  })
})
