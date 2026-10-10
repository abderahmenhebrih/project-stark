import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  extensionTrustKey,
  isExtensionTrusted,
  readExtensionTrustStates,
  writeExtensionTrust
} from './extension-trust'

const A = { namespace: 'dbaeumer', name: 'vscode-eslint', version: '3.0.0' }
const A_NEW = { namespace: 'dbaeumer', name: 'vscode-eslint', version: '3.0.1' }

describe('extension trust store', () => {
  it('defaults to untrusted and grants trust per exact version', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-trust-'))
    try {
      assert.equal(isExtensionTrusted(root, A), false)
      writeExtensionTrust(root, A, true)
      assert.equal(isExtensionTrusted(root, A), true)
      assert.equal(extensionTrustKey(A), 'dbaeumer.vscode-eslint@3.0.0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never inherits trust across versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-trust-ver-'))
    try {
      writeExtensionTrust(root, A, true)
      assert.equal(isExtensionTrusted(root, A_NEW), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('revokes trust by removing the key', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-trust-revoke-'))
    try {
      writeExtensionTrust(root, A, true)
      writeExtensionTrust(root, A, false)
      assert.equal(isExtensionTrusted(root, A), false)
      assert.equal(readExtensionTrustStates(root).size, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads corrupt state as untrusted (fail closed)', () => {
    assert.equal(readExtensionTrustStates('').size, 0)
    assert.equal(readExtensionTrustStates(join(tmpdir(), 'stark-trust-missing-xyz')).size, 0)
  })
})
