import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  getExtensionConfigValue,
  isValidConfigKey,
  isValidConfigValue,
  readExtensionConfigs,
  writeExtensionConfigValue
} from './extension-config'

const EXT = 'esbenp.prettier-vscode@12.4.0'

describe('extension configuration store', () => {
  it('reads missing config as empty (defaults win)', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-config-'))
    try {
      const configs = readExtensionConfigs(root)
      assert.equal(getExtensionConfigValue(configs, EXT, 'prettier', 'tabWidth', 2), 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('round-trips validated primitives without touching settings files', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-config-rw-'))
    try {
      writeExtensionConfigValue(root, EXT, 'prettier.tabWidth', 4)
      writeExtensionConfigValue(root, EXT, 'prettier.singleQuote', true)
      const configs = readExtensionConfigs(root)
      assert.equal(getExtensionConfigValue(configs, EXT, 'prettier', 'tabWidth', 2), 4)
      assert.equal(getExtensionConfigValue(configs, EXT, 'prettier', 'singleQuote', false), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects non-primitive values and malformed keys', () => {
    assert.equal(isValidConfigKey('prettier.tabWidth'), true)
    assert.equal(isValidConfigKey(''), false)
    assert.equal(isValidConfigKey('../escape'), false)
    assert.equal(isValidConfigValue({ nested: true }), false)
    assert.equal(isValidConfigValue(() => {}), false)
    assert.equal(isValidConfigValue('ok'), true)
    const root = mkdtempSync(join(tmpdir(), 'stark-config-bad-'))
    try {
      assert.throws(() => writeExtensionConfigValue(root, EXT, 'bad key!', 1), /not valid/)
      assert.throws(() => writeExtensionConfigValue(root, EXT, 'prettier.deep', { a: 1 }), /not valid/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
