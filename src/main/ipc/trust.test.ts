import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RendererTrustPolicy } from './sender'
import { isTrustedIpcSender } from './trust'

const DEV_URL = 'http://localhost:5173/'
const ENTRY_FILE = 'C:\\app\\out\\renderer\\index.html'
const ENTRY_URL = 'file:///C:/app/out/renderer/index.html'

function devPolicy(): RendererTrustPolicy {
  return { devServerUrl: DEV_URL, rendererEntryFile: ENTRY_FILE }
}

function prodPolicy(): RendererTrustPolicy {
  return { devServerUrl: undefined, rendererEntryFile: ENTRY_FILE }
}

describe('IPC sender trust', () => {
  it('destroyed senders are always rejected', () => {
    assert.equal(isTrustedIpcSender(true, DEV_URL, devPolicy()), false)
    assert.equal(isTrustedIpcSender(true, ENTRY_URL, prodPolicy()), false)
  })

  it('development trusts the dev-server origin only', () => {
    assert.equal(isTrustedIpcSender(false, 'http://localhost:5173/', devPolicy()), true)
    assert.equal(isTrustedIpcSender(false, 'http://localhost:5173/#/x', devPolicy()), true)
    assert.equal(isTrustedIpcSender(false, 'http://localhost:9999/', devPolicy()), false)
    assert.equal(isTrustedIpcSender(false, 'https://evil.example/', devPolicy()), false)
    assert.equal(isTrustedIpcSender(false, ENTRY_URL, devPolicy()), false)
  })

  it('production trusts the exact renderer entry document', () => {
    assert.equal(isTrustedIpcSender(false, ENTRY_URL, prodPolicy()), true)
  })

  it('production accounts for platform path spelling', () => {
    const caseVariant = isTrustedIpcSender(false, 'file:///c:/APP/out/renderer/index.html', prodPolicy())
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.equal(caseVariant, true)
    } else {
      assert.equal(caseVariant, false)
    }
  })

  it('production rejects foreign same-name files', () => {
    const foreign = [
      'file:///C:/other/renderer/index.html',
      'file:///tmp/renderer/index.html',
      'file:///malicious/index.html',
      'file:///C:/STARK-copy/renderer/index.html',
      'file:///tmp/index.html'
    ]
    for (const url of foreign) {
      assert.equal(isTrustedIpcSender(false, url, prodPolicy()), false, url)
    }
  })

  it('production rejects traversal and encoded variants', () => {
    assert.equal(
      isTrustedIpcSender(false, 'file:///C:/app/out/renderer/sub/../../other.html', prodPolicy()),
      false
    )
    assert.equal(
      isTrustedIpcSender(false, 'file:///C:/app/out/renderer/%2E%2E/other.html', prodPolicy()),
      false
    )
  })

  it('production rejects non-file and foreign-host senders', () => {
    assert.equal(isTrustedIpcSender(false, 'https://example.com/', prodPolicy()), false)
    assert.equal(isTrustedIpcSender(false, 'http://localhost:5173/', prodPolicy()), false)
    assert.equal(isTrustedIpcSender(false, 'file://evil/C:/app/out/renderer/index.html', prodPolicy()), false)
    assert.equal(isTrustedIpcSender(false, 'javascript:alert(1)', prodPolicy()), false)
    assert.equal(isTrustedIpcSender(false, 'data:text/html,<h1>x</h1>', prodPolicy()), false)
  })

  it('production fails closed without a known entry file', () => {
    const noEntry: RendererTrustPolicy = { devServerUrl: undefined, rendererEntryFile: undefined }
    const emptyEntry: RendererTrustPolicy = { devServerUrl: undefined, rendererEntryFile: '' }
    assert.equal(isTrustedIpcSender(false, ENTRY_URL, noEntry), false)
    assert.equal(isTrustedIpcSender(false, ENTRY_URL, emptyEntry), false)
  })

  it('missing or garbage sender URLs are rejected', () => {
    assert.equal(isTrustedIpcSender(false, undefined, devPolicy()), false)
    assert.equal(isTrustedIpcSender(false, '', devPolicy()), false)
    assert.equal(isTrustedIpcSender(false, ':::', devPolicy()), false)
    assert.equal(isTrustedIpcSender(false, undefined, prodPolicy()), false)
  })
})
