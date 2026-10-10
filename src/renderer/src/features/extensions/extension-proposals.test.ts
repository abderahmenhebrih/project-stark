import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyProposalEdits, groupProposalEditsByUri, relativePathFromProposalUri } from './extension-proposals'
import { extensionDocUri, removeTrustRequest, requestExtensionTrust, resetTrustQueueForTests, subscribeTrustQueue } from './extension-trust-bus'

describe('extension proposal helpers', () => {
  it('maps absolute uris via the workspace root and passes bare relatives through', () => {
    assert.equal(relativePathFromProposalUri('file:///C:/ws/proj/src/a.ts', 'C:\\ws\\proj'), 'src/a.ts')
    assert.equal(relativePathFromProposalUri('file:C:/ws/proj/src/a.ts', 'C:/ws/proj'), 'src/a.ts')
    assert.equal(relativePathFromProposalUri('file:src/a.ts', 'C:/ws/proj'), 'src/a.ts')
    assert.equal(relativePathFromProposalUri('file:///etc/passwd', 'C:/ws/proj'), null)
    assert.equal(relativePathFromProposalUri('file:C:/ws/proj/../evil.ts', 'C:/ws/proj'), null)
  })

  it('applies non-overlapping edits in memory without touching disk', () => {
    const result = applyProposalEdits('line1\nline2\n', [
      { uri: 'file:a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'LINE1' }
    ])
    assert.equal(result, 'LINE1\nline2\n')
    assert.throws(
      () =>
        applyProposalEdits('ab', [
          { uri: 'file:a', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: 'x' },
          { uri: 'file:a', range: { start: { line: 0, character: 1 }, end: { line: 1, character: 0 } }, newText: 'y' }
        ]),
      /overlap/
    )
  })

  it('groups edits by uri deterministically', () => {
    const groups = groupProposalEditsByUri([
      { uri: 'file:b', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'b' },
      { uri: 'file:a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'a' }
    ])
    assert.deepEqual(groups.map((group) => group.uri), ['file:a', 'file:b'])
  })
})

describe('extension trust bus', () => {
  it('dedupes requests by exact version and removes on resolve', () => {
    resetTrustQueueForTests()
    let seen = 0
    const unsubscribe = subscribeTrustQueue((requests) => {
      seen = requests.length
    })
    try {
      requestExtensionTrust({ namespace: 'a', name: 'b', version: '1.0.0', displayName: 'B' })
      requestExtensionTrust({ namespace: 'a', name: 'b', version: '1.0.0', displayName: 'B' })
      assert.equal(seen, 1)
      removeTrustRequest('a.b@1.0.0')
      assert.equal(seen, 0)
    } finally {
      unsubscribe()
      resetTrustQueueForTests()
    }
  })

  it('builds host document uris from relative paths', () => {
    assert.equal(extensionDocUri('src\\a.ts'), 'file:src/a.ts')
  })
})
