import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'
import {
  WORKER_ATTACHMENT_IMPORT_DENY_MESSAGE,
  WORKER_ATTACHMENT_IMPORT_UNKNOWN_MESSAGE,
  WORKER_ATTACHMENT_IMPORT_USER_DENY_MESSAGE,
  buildAttachmentImportApprovalSummary,
  parseAttachmentImportArgs
} from './worker-attachment-import-validation'

describe('attachment_import argument validation', () => {
  it('accepts one to ten opaque IDs plus destinations', () => {
    const parsed = parseAttachmentImportArgs({
      imports: [{ attachmentId: 'a'.repeat(32), proposedRelativePath: 'public/hero.png' }]
    })
    assert.equal(parsed.imports.length, 1)
    assert.equal(parsed.imports[0]?.attachmentId, 'a'.repeat(32))
    const many = parseAttachmentImportArgs({
      imports: Array.from({ length: 10 }, (_, index) => ({
        attachmentId: String(index).padStart(32, '0'),
        proposedRelativePath: `img/${String(index)}.png`
      }))
    })
    assert.equal(many.imports.length, 10)
  })

  it('rejects paths, extra keys, malformed IDs, and bad counts', () => {
    const good = { attachmentId: 'a'.repeat(32), proposedRelativePath: 'public/hero.png' }
    for (const bad of [
      { imports: [] },
      { imports: Array.from({ length: 11 }, () => ({ ...good })) },
      { imports: [{ ...good, sourcePath: '/tmp/x.png' }] },
      { imports: [{ proposedRelativePath: 'public/hero.png' }] },
      { imports: [{ attachmentId: 'a'.repeat(32) }] },
      { imports: [{ attachmentId: '/tmp/hero.png', proposedRelativePath: 'public/hero.png' }] },
      { imports: [{ attachmentId: 'XYZ', proposedRelativePath: 'public/hero.png' }] },
      { imports: [{ attachmentId: 'a'.repeat(32), proposedRelativePath: '' }] },
      {
        imports: [
          { attachmentId: 'a'.repeat(32), proposedRelativePath: 'public/hero.png' },
          { attachmentId: 'b'.repeat(32), proposedRelativePath: 'public/hero.png' }
        ]
      },
      { imports: 'nope' },
      { changes: [] }
    ]) {
      assert.throws(() => parseAttachmentImportArgs(bad), InvalidWorkerToolRequestError)
    }
  })

  it('builds exact approval summaries with non-apply copy', () => {
    const single = buildAttachmentImportApprovalSummary([{ fileName: 'hero.png', destination: 'public/images/hero.png' }])
    assert.ok(single.includes('Propose importing hero.png to public/images/hero.png'))
    assert.ok(single.includes('- hero.png → public/images/hero.png'))
    assert.ok(single.includes('does not modify files'))
    assert.ok(!single.includes('stark-attachment'))
    const multi = buildAttachmentImportApprovalSummary([
      { fileName: 'a.png', destination: 'img/a.png' },
      { fileName: 'b.png', destination: 'img/b.png' }
    ])
    assert.ok(multi.includes('Propose importing 2 chat attachments'))
  })

  it('carries stable safe copy', () => {
    assert.ok(WORKER_ATTACHMENT_IMPORT_DENY_MESSAGE.includes('not allowed'))
    assert.ok(WORKER_ATTACHMENT_IMPORT_USER_DENY_MESSAGE.includes('denied'))
    assert.ok(WORKER_ATTACHMENT_IMPORT_UNKNOWN_MESSAGE.includes('Unknown'))
  })
})
