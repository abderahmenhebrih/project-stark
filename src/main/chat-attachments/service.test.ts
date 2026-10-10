import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import {
  AttachmentNotFoundError,
  InvalidAttachmentRequestError,
  AttachmentTooLargeError,
  TooManyAttachmentsError,
  UnsupportedAttachmentError,
  toPublicAttachmentError
} from './errors'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES
} from './limits'
import { resolveMimeType, sniffImageMime } from './mime'
import { ATTACHMENT_PROTOCOL, parseAttachmentUrl, serveAttachmentRequest } from './protocol'
import {
  ChatAttachmentService,
  generateAttachmentId,
  isValidAttachmentId,
  normalizeAttachmentName
} from './service'

function openHarness(): {
  db: DatabaseSync
  service: ChatAttachmentService
  dir: string
  storeRoot: string
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-attach-'))
  const storeRoot = join(dir, 'attachments')
  const created = workspaces.create({ rootPath: join(dir, 'project'), displayName: 'project', now: 1000 })
  return { db, service: new ChatAttachmentService(storeRoot, workspaces, sessions), dir, storeRoot, workspaceId: created.id }
}

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fakepngdatafakepngdata')
  ])
}

function tryLink(target: string, linkPath: string, type: 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, linkPath, type)
    return true
  } catch {
    return false
  }
}

describe('chat attachment ids and names', () => {
  it('generates opaque main-side ids and validates them strictly', () => {
    const first = generateAttachmentId()
    const second = generateAttachmentId()
    assert.ok(isValidAttachmentId(first))
    assert.ok(isValidAttachmentId(second))
    assert.ok(first !== second)
    for (const bad of ['', 'xyz', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), null, 42, '../evil']) {
      assert.ok(!isValidAttachmentId(bad))
    }
  })

  it('normalizes display names without path components', () => {
    assert.equal(normalizeAttachmentName('C:\\Users\\ava\\photo.png'), 'photo.png')
    assert.equal(normalizeAttachmentName('/home/ava/../../evil'), 'evil')
    assert.equal(normalizeAttachmentName('   '), 'attachment')
    assert.equal(normalizeAttachmentName('a'.repeat(200)), 'a'.repeat(120))
     
    assert.equal(normalizeAttachmentName('a\x00b'), 'ab')
  })
})

describe('chat attachment MIME handling', () => {
  it('sniffs raster image signatures, never extensions', () => {
    assert.equal(sniffImageMime(pngBytes()), 'image/png')
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
    assert.equal(sniffImageMime(Buffer.from('GIF89a', 'ascii')), 'image/gif')
    assert.equal(
      sniffImageMime(Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')])),
      'image/webp'
    )
    assert.equal(sniffImageMime(Buffer.from('not an image')), null)
    assert.equal(sniffImageMime(Buffer.alloc(0)), null)
  })

  it('resolves display MIME conservatively with an octet-stream fallback', () => {
    assert.equal(resolveMimeType(pngBytes(), 'photo.bin'), 'image/png')
    assert.equal(resolveMimeType(Buffer.from('hello'), 'notes.txt'), 'text/plain')
    assert.equal(resolveMimeType(Buffer.from('hello'), 'data.json'), 'application/json')
    assert.equal(resolveMimeType(Buffer.from('hello'), 'doc.pdf'), 'application/pdf')
    assert.equal(resolveMimeType(Buffer.from('hello'), 'mystery.zzz'), 'application/octet-stream')
    assert.equal(resolveMimeType(Buffer.from('hello'), 'noext'), 'application/octet-stream')
  })
})

describe('chat attachment store', () => {
  it('stores picked files with normalized metadata and no paths', async () => {
    const { db, dir, service, storeRoot, workspaceId } = openHarness()
    try {
      const source = join(dir, 'photo.png')
      writeFileSync(source, pngBytes())
      const [stored] = await service.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      assert.ok(isValidAttachmentId(stored.id))
      assert.equal(stored.name, 'photo.png')
      assert.equal(stored.mimeType, 'image/png')
      assert.equal(stored.kind, 'image')
      assert.equal(stored.size, pngBytes().length)
      const expectedSha = createHash('sha256').update(pngBytes()).digest('hex')
      const row = db.prepare('SELECT sha256 FROM chat_attachments WHERE id = ?').get(stored.id) as unknown as Record<string, unknown>
      assert.equal(row['sha256'], expectedSha)
      const shard = join(storeRoot, stored.id.slice(0, 2), `${stored.id}.bin`)
      assert.ok(existsSync(shard))
      assert.equal(readFileSync(shard).toString('hex'), pngBytes().toString('hex'))
      const serialized = JSON.stringify(stored)
      assert.ok(!serialized.includes(dir))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies bytes and hashes, surviving source removal', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const source = join(dir, 'notes.md')
      writeFileSync(source, '# Notes\n')
      const [stored] = await service.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      assert.equal(stored.mimeType, 'text/markdown')
      assert.equal(stored.kind, 'file')
      rmSync(source)
      const content = service.readAttachmentContent(stored.id)
      assert.equal(content.bytes.toString('utf8'), '# Notes\n')
      assert.equal(content.mimeType, 'text/markdown')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stores oversized images as files and rejects missing sources', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const bigImage = join(dir, 'big.png')
      const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      writeFileSync(bigImage, Buffer.concat([header, Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1)]))
      const [stored] = await service.chooseAttachments(workspaceId, [bigImage])
      assert.ok(stored !== undefined)
      assert.equal(stored.kind, 'file')
      await assert.rejects(service.chooseAttachments(workspaceId, [join(dir, 'missing.bin')]), UnsupportedAttachmentError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects directories, symlinks, and special entries', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const subdir = join(dir, 'sub')
      mkdirSync(subdir, { recursive: true })
      await assert.rejects(service.chooseAttachments(workspaceId, [subdir]), UnsupportedAttachmentError)
      const real = join(dir, 'real.txt')
      writeFileSync(real, 'real')
      const link = join(dir, 'link.txt')
      if (tryLink(real, link, 'file')) {
        await assert.rejects(service.chooseAttachments(workspaceId, [link]), UnsupportedAttachmentError)
      } else {
        console.warn('skipped: symlink case needs link privileges')
      }
      await assert.rejects(service.chooseAttachments(workspaceId, ['']), InvalidAttachmentRequestError)
      await assert.rejects(service.chooseAttachments(workspaceId, 'nope' as unknown as string[]), InvalidAttachmentRequestError)
      await assert.rejects(
        service.chooseAttachments(workspaceId, Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => real)),
        TooManyAttachmentsError
      )
      await assert.rejects(service.chooseAttachments(999999, [real]), InvalidAttachmentRequestError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects files over 25 MiB without storing them', async () => {
    const { db, dir, service, storeRoot, workspaceId } = openHarness()
    try {
      const huge = join(dir, 'huge.bin')
      writeFileSync(huge, Buffer.alloc(64))
      // Sparse-grow past the bound without writing 25 MiB.
      const handle = openSync(huge, 'r+')
      ftruncateSync(handle, MAX_ATTACHMENT_BYTES + 1)
      closeSync(handle)
      await assert.rejects(service.chooseAttachments(workspaceId, [huge]), AttachmentTooLargeError)
      assert.ok(!existsSync(storeRoot) || isEmptyTree(storeRoot))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function isEmptyTree(path: string): boolean {
    const walk = (current: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          out.push(...walk(full))
        } else {
          out.push(full)
        }
      }
      return out
    }
    return walk(path).length === 0
  }
})

describe('chat attachment drafts and send resolution', () => {
  it('removes uncommitted drafts with their backing file', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const source = join(dir, 'draft.txt')
      writeFileSync(source, 'draft')
      const [stored] = await service.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      const removed = await service.removeDraft(stored.id)
      assert.equal(removed.id, stored.id)
      await assert.rejects(service.removeDraft(stored.id), AttachmentNotFoundError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps committed backing assets on draft removal', async () => {
    const { db, dir, service, storeRoot, workspaceId } = openHarness()
    try {
      const source = join(dir, 'keep.txt')
      writeFileSync(source, 'keep')
      const [stored] = await service.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      db.exec(
        `INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (${workspaceId}, 's', 1, 1)`
      )
      db.exec(`INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)`)
      db.exec(
        `INSERT INTO message_attachments (message_id, attachment_id, original_name, mime_type, size_bytes, kind, sha256, created_at) ` +
          `VALUES (1, '${stored.id}', 'keep.txt', 'text/plain', 4, 'file', '${'0'.repeat(64)}', 1)`
      )
      const kept = await service.removeDraft(stored.id)
      assert.equal(kept.id, stored.id)
      assert.ok(existsSync(join(storeRoot, stored.id.slice(0, 2), `${stored.id}.bin`)))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves send IDs with count and aggregate budgets', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const first = join(dir, 'a.txt')
      const second = join(dir, 'b.txt')
      writeFileSync(first, 'a')
      writeFileSync(second, 'b')
      const [a, b] = await service.chooseAttachments(workspaceId, [first, second])
      assert.ok(a !== undefined && b !== undefined)
      const resolved = await service.resolveAttachmentsForSend([a.id, b.id], 2000)
      assert.equal(resolved.length, 2)
      assert.equal(resolved[0]?.attachmentId, a.id)
      assert.deepEqual(await service.resolveAttachmentsForSend(undefined, 2000), [])
      await assert.rejects(service.resolveAttachmentsForSend('nope', 2000), InvalidAttachmentRequestError)
      await assert.rejects(service.resolveAttachmentsForSend(['xyz'], 2000), InvalidAttachmentRequestError)
      await assert.rejects(service.resolveAttachmentsForSend(['0'.repeat(32)], 2000), AttachmentNotFoundError)
      await assert.rejects(
        service.resolveAttachmentsForSend(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => a.id), 2000),
        TooManyAttachmentsError
      )
      assert.ok(MAX_MESSAGE_ATTACHMENT_BYTES > MAX_ATTACHMENT_BYTES)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps failures to safe public copy', () => {
    assert.equal(toPublicAttachmentError('choose', new Error('socket hang up')).message, 'We couldn’t attach those files.')
    assert.equal(toPublicAttachmentError('send', new Error('x')).message, 'We couldn’t send those attachments.')
    assert.equal(toPublicAttachmentError('remove', new Error('x')).message, 'We couldn’t remove that attachment.')
    assert.equal(toPublicAttachmentError('serve', new Error('x')).message, 'We couldn’t load that attachment.')
    assert.equal(
      toPublicAttachmentError('choose', new InvalidAttachmentRequestError()).message,
      'That attachment request is not valid.'
    )
  })
})

describe('stark-attachment protocol', () => {
  it('parses only exact opaque-ID URLs', () => {
    const id = 'a'.repeat(32)
    assert.equal(parseAttachmentUrl(`${ATTACHMENT_PROTOCOL}://${id}`), id)
    assert.equal(parseAttachmentUrl(`${ATTACHMENT_PROTOCOL}://${id}/`), id)
    for (const bad of [
      '',
      'https://example.com/x',
      `${ATTACHMENT_PROTOCOL}://short`,
      `${ATTACHMENT_PROTOCOL}://${id}/extra`,
      `${ATTACHMENT_PROTOCOL}://${id}?x=1`,
      `${ATTACHMENT_PROTOCOL}://${id}#x`,
      `${ATTACHMENT_PROTOCOL}://user@${id}`,
      `${ATTACHMENT_PROTOCOL}://${id}:99`,
      'stark-attachment://',
      `${ATTACHMENT_PROTOCOL}://../${id}`
    ]) {
      assert.equal(parseAttachmentUrl(bad), null)
    }
  })

  it('serves stored bytes with content headers and 404s otherwise', () => {
    const png = pngBytes()
    const ok = serveAttachmentRequest(`${ATTACHMENT_PROTOCOL}://${'b'.repeat(32)}`, () => ({
      bytes: png,
      mimeType: 'image/png'
    }))
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('Content-Type'), 'image/png')
    assert.equal(ok.headers.get('Content-Length'), String(png.length))
    const missing = serveAttachmentRequest(`${ATTACHMENT_PROTOCOL}://${'c'.repeat(32)}`, () => {
      throw new Error('gone')
    })
    assert.equal(missing.status, 404)
    const malformed = serveAttachmentRequest('https://example.com/x', () => ({ bytes: png, mimeType: 'image/png' }))
    assert.equal(malformed.status, 404)
  })

  it('serves real stored attachments end to end', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const source = join(dir, 'real.png')
      writeFileSync(source, pngBytes())
      const [stored] = await service.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      const response = serveAttachmentRequest(`${ATTACHMENT_PROTOCOL}://${stored.id}`, (id) =>
        service.readAttachmentContent(id)
      )
      assert.equal(response.status, 200)
      assert.equal(await response.arrayBuffer().then((buffer) => Buffer.from(buffer).toString('hex')), pngBytes().toString('hex'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
