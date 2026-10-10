import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ChatAttachmentService } from '../chat-attachments/service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { capabilitiesForModel, planAiAttachments, AttachmentUnavailableForAiError } from './ai-attachment-context'
import { resolveAiAttachmentPayloads } from './ai-attachment-resolver'

function openHarness(): {
  db: DatabaseSync
  store: CodingSessionRepository
  attachments: ChatAttachmentService
  sessions: CodingSessionService
  dir: string
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const store = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-ai-resolve-'))
  const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, store)
  const created = workspaces.create({ rootPath: join(dir, 'project'), displayName: 'project', now: 1000 })
  const sessions = new CodingSessionService(workspaces, store, { attachmentService: attachments })
  return { db, store, attachments, sessions, dir, workspaceId: created.id }
}

function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fakepngdata')])
}

async function commitOne(
  h: ReturnType<typeof openHarness>,
  filename: string,
  bytes: Buffer,
  content = 'Use this'
): Promise<{ sessionId: number; messageId: number; attachmentId: string }> {
  const source = join(h.dir, filename)
  writeFileSync(source, bytes)
  const [stored] = await h.attachments.chooseAttachments(h.workspaceId, [source])
  if (stored === undefined) {
    throw new Error('unreachable')
  }
  const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
  const sent = await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content, attachments: [stored.id] })
  return { sessionId: session.id, messageId: sent.message.id, attachmentId: stored.id }
}

function linksFor(h: ReturnType<typeof openHarness>, messageId: number) {
  const rows = h.store.listAttachmentsForMessage(messageId)
  return new Map(
    rows.map(
      (row) =>
        [row.attachmentId, { mimeType: row.mimeType, sizeBytes: row.sizeBytes, kind: row.kind, sha256: row.sha256 }] as const
    )
  )
}

function planFor(h: ReturnType<typeof openHarness>, messageId: number, model: string) {
  const rows = h.store.listAttachmentsForMessage(messageId)
  return planAiAttachments({
    rows: rows.map((row) => ({
      attachmentId: row.attachmentId,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind
    })),
    capabilities: capabilitiesForModel('openai', model)
  })
}

describe('AI attachment resolver', () => {
  it('resolves image bytes main-side with stored metadata only', async () => {
    const h = openHarness()
    try {
      const { messageId, attachmentId } = await commitOne(h, 'hero.png', pngBytes())
      const plan = planFor(h, messageId, 'gpt-4o')
      const resolved = resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: linksFor(h, messageId) })
      assert.equal(resolved.payloads.length, 1)
      const payload = resolved.payloads[0]
      assert.ok(payload?.kind === 'image')
      assert.equal(payload.id, attachmentId)
      assert.equal(payload.mimeType, 'image/png')
      assert.equal(Buffer.from(payload.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(resolved.outcomes.get(attachmentId)?.included, true)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('resolves bounded text attachments as separate content', async () => {
    const h = openHarness()
    try {
      const { messageId } = await commitOne(h, 'notes.md', Buffer.from('# Hello\nworld\n', 'utf8'))
      const plan = planFor(h, messageId, 'gpt-3.5-turbo')
      assert.equal(plan.attachments[0]?.contentCapability, 'text')
      const resolved = resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: linksFor(h, messageId) })
      const payload = resolved.payloads[0]
      assert.ok(payload?.kind === 'text')
      assert.ok(payload.text.includes('# Hello'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('presents binary documents as metadata-only without content', async () => {
    const h = openHarness()
    try {
      const { messageId, attachmentId } = await commitOne(h, 'doc.pdf', Buffer.from('%PDF-1.4 fake', 'utf8'))
      const plan = planFor(h, messageId, 'gpt-4o')
      assert.equal(plan.attachments[0]?.contentCapability, 'metadata-only')
      const resolved = resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: linksFor(h, messageId) })
      assert.equal(resolved.payloads[0]?.kind, 'metadata')
      assert.equal(resolved.outcomes.get(attachmentId)?.included, false)
      assert.ok((resolved.outcomes.get(attachmentId)?.note ?? '').includes('content not included'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid attachment IDs without touching the store', async () => {
    const h = openHarness()
    try {
      const { messageId } = await commitOne(h, 'hero.png', pngBytes())
      const plan = planFor(h, messageId, 'gpt-4o')
      const tampered = {
        attachments: plan.attachments.map((entry) => ({ ...entry, id: 'not-an-id' })),
        textBudgetBytes: plan.textBudgetBytes
      }
      assert.throws(
        () => resolveAiAttachmentPayloads({ plan: tampered, sessions: h.store, attachments: h.attachments, messageLinks: linksFor(h, messageId) }),
        AttachmentUnavailableForAiError
      )
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('rejects unlinked IDs and stored-metadata mismatches', async () => {
    const h = openHarness()
    try {
      const { messageId } = await commitOne(h, 'hero.png', pngBytes())
      const plan = planFor(h, messageId, 'gpt-4o')
      // Unlinked: links map without the attachment.
      assert.throws(
        () => resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: new Map() }),
        AttachmentUnavailableForAiError
      )
      // Tampered link metadata (renderer-supplied MIME can never drive ingestion).
      const rows = h.store.listAttachmentsForMessage(messageId)
      const evil = new Map(
        rows.map(
          (row) => [row.attachmentId, { mimeType: 'image/png', sizeBytes: row.sizeBytes + 1, kind: row.kind, sha256: row.sha256 }] as const
        )
      )
      assert.throws(
        () => resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: evil }),
        AttachmentUnavailableForAiError
      )
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('rejects vanished store files without partial payloads', async () => {
    const h = openHarness()
    try {
      const { messageId, attachmentId } = await commitOne(h, 'hero.png', pngBytes())
      // Simulate store loss main-side: the committed link and metadata
      // row survive but the backing file is gone — resolution must
      // fail closed with no partial payload.
      const { rmSync: removeSync } = await import('node:fs')
      removeSync(join(h.dir, 'attachments', attachmentId.slice(0, 2), `${attachmentId}.bin`), { force: true })
      const plan = planFor(h, messageId, 'gpt-4o')
      assert.throws(
        () => resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: linksFor(h, messageId) }),
        AttachmentUnavailableForAiError
      )
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('preserves multi-attachment ordering', async () => {
    const h = openHarness()
    try {
      const first = join(h.dir, 'a.txt')
      const second = join(h.dir, 'b.txt')
      writeFileSync(first, 'alpha')
      writeFileSync(second, 'beta')
      const [a, b] = await h.attachments.chooseAttachments(h.workspaceId, [first, second])
      if (a === undefined || b === undefined) {
        throw new Error('unreachable')
      }
      const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
      const sent = await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'two', attachments: [a.id, b.id] })
      const plan = planFor(h, sent.message.id, 'gpt-3.5-turbo')
      assert.deepEqual(plan.attachments.map((entry) => entry.id), [a.id, b.id])
      const resolved = resolveAiAttachmentPayloads({ plan, sessions: h.store, attachments: h.attachments, messageLinks: linksFor(h, sent.message.id) })
      assert.ok(resolved.payloads[0]?.kind === 'text' && resolved.payloads[0].text === 'alpha')
      assert.ok(resolved.payloads[1]?.kind === 'text' && resolved.payloads[1].text === 'beta')
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})
