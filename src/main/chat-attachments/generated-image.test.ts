import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { MAX_ATTACHMENT_BYTES } from './limits'
import { AttachmentTooLargeError, UnsupportedAttachmentError } from './errors'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChatAttachmentService } from './service'

function pngBytes(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)])
}

function openHarness(): { db: DatabaseSync; dir: string; service: ChatAttachmentService; rows: CodingSessionRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const dir = mkdtempSync(join(tmpdir(), 'stark-gen-attach-'))
  const service = new ChatAttachmentService(join(dir, 'attachments'), new WorkspaceRepository(db), new CodingSessionRepository(db))
  return { db, dir, service, rows: new CodingSessionRepository(db) }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

describe('generated image attachments', () => {
  it('stores provider bytes as a normal attachment with exact SHA-256', async () => {
    const h = openHarness()
    try {
      const bytes = pngBytes('generated')
      const attachment = await h.service.createGeneratedImage({ bytes, mimeType: 'image/png', displayName: 'generated-image-1.png' })
      assert.equal(attachment.kind, 'image')
      assert.equal(attachment.mimeType, 'image/png')
      assert.equal(attachment.name, 'generated-image-1.png')
      assert.equal(attachment.size, bytes.length)
      const row = h.rows.findChatAttachmentById(attachment.id)
      assert.ok(row !== undefined)
      assert.equal(row?.sha256, createHash('sha256').update(bytes).digest('hex'))
      const content = h.service.readAttachmentContent(attachment.id)
      assert.ok(Buffer.from(content.bytes).equals(bytes))
    } finally {
      closeHarness(h)
    }
  })

  it('verifies magic bytes and never trusts Content-Type alone', async () => {
    const h = openHarness()
    try {
      await assert.rejects(
        h.service.createGeneratedImage({ bytes: Buffer.from('plain text bytes'), mimeType: 'image/png' }),
        UnsupportedAttachmentError
      )
      // MIME mismatch against sniffed bytes is rejected too.
      await assert.rejects(
        h.service.createGeneratedImage({ bytes: pngBytes('x'), mimeType: 'image/jpeg' }),
        UnsupportedAttachmentError
      )
    } finally {
      closeHarness(h)
    }
  })

  it('rejects oversize and empty provider output', async () => {
    const h = openHarness()
    try {
      await assert.rejects(
        h.service.createGeneratedImage({ bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), mimeType: 'image/png' }),
        AttachmentTooLargeError
      )
      await assert.rejects(
        h.service.createGeneratedImage({ bytes: Buffer.alloc(0), mimeType: 'image/png' }),
        AttachmentTooLargeError
      )
    } finally {
      closeHarness(h)
    }
  })

  it('falls back to a safe display name and strips path components', async () => {
    const h = openHarness()
    try {
      const unnamed = await h.service.createGeneratedImage({ bytes: pngBytes('a') , mimeType: 'image/png' })
      assert.equal(unnamed.name, 'generated-image.png')
      const traversal = await h.service.createGeneratedImage({ bytes: pngBytes('b'), mimeType: 'image/png', displayName: '../../evil.png' })
      assert.equal(traversal.name, 'evil.png')
    } finally {
      closeHarness(h)
    }
  })
})
