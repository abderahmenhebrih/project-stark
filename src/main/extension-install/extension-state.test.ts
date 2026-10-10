import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  EXTENSION_STATE_FILE_NAME,
  EXTENSION_STATE_MAX_BYTES,
  extensionStateKey,
  readExtensionEnabledStates,
  writeExtensionEnabledStates
} from './extension-state'

function openDir(): string {
  return mkdtempSync(join(tmpdir(), 'stark-ext-state-'))
}

describe('extension enabled-state file', () => {
  it('round-trips exact-identity flags through a main-owned path', () => {
    const dir = openDir()
    try {
      const states = new Map<string, boolean>([
        ['esbenp.prettier-vscode@12.4.0', true],
        ['meta.pyrefly@1.3.9003', false]
      ])
      writeExtensionEnabledStates(dir, states)
      const files = readdirSync(dir)
      assert.ok(files.includes(EXTENSION_STATE_FILE_NAME), 'state must live in the main-owned file')
      assert.ok(!files.some((name) => name.endsWith('.tmp')), 'no temp file may be left behind')
      const raw = JSON.parse(readFileSync(join(dir, EXTENSION_STATE_FILE_NAME), 'utf8')) as Record<string, unknown>
      assert.equal(raw['version'], 1)
      assert.deepEqual(readExtensionEnabledStates(dir), states)
      assert.equal(extensionStateKey({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }), 'esbenp.prettier-vscode@12.4.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('missing, oversize, or malformed files read back as empty (never throws, never deletes)', () => {
    const dir = openDir()
    try {
      assert.deepEqual(readExtensionEnabledStates(dir), new Map())
      for (const bad of [
        'not json{{{',
        '42',
        'null',
        '[1,2]',
        '{"version":2,"extensions":{}}',
        '{"version":1}',
        '{"version":1,"extensions":null}',
        '{"version":1,"extensions":{"esbenp.prettier-vscode@12.4.0":true}}',
        '{"version":1,"extensions":{"esbenp.prettier-vscode@12.4.0":{"enabled":"yes"}}}',
        '{"version":1,"extensions":{"esbenp.prettier-vscode@12.4.0":{"enabled":true,"extra":1}}}',
        '{"version":1,"extensions":{"../evil@1.0.0":{"enabled":true}}}',
        '{"version":1,"extensions":{"https://evil.example":{"enabled":true}}}'
      ]) {
        writeFileSync(join(dir, EXTENSION_STATE_FILE_NAME), bad)
        assert.deepEqual(readExtensionEnabledStates(dir), new Map(), `must fail safe for ${bad.slice(0, 40)}`)
      }
      writeFileSync(join(dir, EXTENSION_STATE_FILE_NAME), `{"version":1,"extensions":{"a.b@1.0.0":{"enabled":true}},"extra":1}`)
      assert.deepEqual(
        readExtensionEnabledStates(dir),
        new Map([['a.b@1.0.0', true]]),
        'unknown top-level fields must not poison valid entries'
      )
      writeFileSync(join(dir, EXTENSION_STATE_FILE_NAME), 'x'.repeat(EXTENSION_STATE_MAX_BYTES + 1))
      assert.deepEqual(readExtensionEnabledStates(dir), new Map(), 'oversize files must read back empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps valid entries while dropping hostile ones', () => {
    const dir = openDir()
    try {
      writeFileSync(
        join(dir, EXTENSION_STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          extensions: {
            'esbenp.prettier-vscode@12.4.0': { enabled: false },
            '../evil@1.0.0': { enabled: true },
            'a.b@1.0.0': { enabled: true, admin: true },
            'x': { enabled: true }
          }
        })
      )
      assert.deepEqual(
        readExtensionEnabledStates(dir),
        new Map([['esbenp.prettier-vscode@12.4.0', false]])
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write path rejects renderer-chosen locations', () => {
    assert.throws(() => writeExtensionEnabledStates('', new Map()), /not valid/)
    assert.deepEqual(readExtensionEnabledStates(''), new Map())
  })
})
