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
import { CodingSessionService } from './coding-session-service'
import { InvalidSessionMessageError } from './errors'

function openHarness(): {
  db: DatabaseSync
  sessions: CodingSessionService
  attachments: ChatAttachmentService
  store: CodingSessionRepository
  dir: string
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const store = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-sess-attach-'))
  const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, store)
  const created = workspaces.create({ rootPath: join(dir, 'project'), displayName: 'project', now: 1000 })
  const sessions = new CodingSessionService(workspaces, store, { attachmentService: attachments })
  return { db, sessions, attachments, store, dir, workspaceId: created.id }
}

describe('session message attachments', () => {
  it('sends text with attachments and persists the links', async () => {
    const { db, dir, sessions, attachments, workspaceId } = openHarness()
    try {
      const source = join(dir, 'photo.png')
      writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
      const [stored] = await attachments.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      const session = await sessions.createSession({ workspaceId })
      const result = await sessions.sendUserMessage({
        workspaceId,
        sessionId: session.id,
        content: 'Look at this',
        attachments: [stored.id]
      })
      assert.equal(result.message.content, 'Look at this')
      assert.equal(result.attachments?.length, 1)
      assert.equal(result.attachments?.[0]?.id, stored.id)
      assert.equal(result.attachments?.[0]?.name, 'photo.png')
      assert.equal(result.message.attachments?.length, 1)
      const page = await sessions.listMessages({ workspaceId, sessionId: session.id })
      assert.equal(page.messages[0]?.attachments?.length, 1)
      assert.equal(page.messages[0]?.attachments?.[0]?.mimeType, 'image/png')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends attachment-only messages with filename-derived titles', async () => {
    const { db, dir, sessions, attachments, workspaceId } = openHarness()
    try {
      const source = join(dir, 'architecture.pdf')
      writeFileSync(source, '%PDF-1.4 fake')
      const [stored] = await attachments.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      const session = await sessions.createSession({ workspaceId })
      const result = await sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: '', attachments: [stored.id] })
      assert.equal(result.message.content, '')
      assert.ok(result.session.title.includes('architecture.pdf'))
      const page = await sessions.listMessages({ workspaceId, sessionId: session.id })
      assert.equal(page.messages[0]?.content, '')
      assert.equal(page.messages[0]?.attachments?.[0]?.name, 'architecture.pdf')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still rejects empty text-only messages', async () => {
    const { db, sessions, workspaceId } = openHarness()
    try {
      const session = await sessions.createSession({ workspaceId })
      await assert.rejects(
        sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: '   ' }),
        InvalidSessionMessageError
      )
    } finally {
      db.close()
    }
  })

  it('rejects unknown, malformed, and over-count attachment IDs', async () => {
    const { db, sessions, workspaceId } = openHarness()
    try {
      const session = await sessions.createSession({ workspaceId })
      await assert.rejects(sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi', attachments: ['0'.repeat(32)] }))
      await assert.rejects(sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi', attachments: ['xyz'] }))
      await assert.rejects(sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi', attachments: 'nope' }))
      await assert.rejects(
        sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi', attachments: Array.from({ length: 11 }, () => 'a'.repeat(32)) })
      )
    } finally {
      db.close()
    }
  })

  it('rejects aggregate attachment bytes over the message bound', async () => {
    const { db, sessions, store, workspaceId } = openHarness()
    try {
      const ids: string[] = []
      for (const suffix of ['a', 'b']) {
        const id = `${suffix.repeat(31)}${suffix === 'a' ? '0' : '1'}`
        store.insertChatAttachment({
          id,
          originalName: `${suffix}.bin`,
          mimeType: 'application/octet-stream',
          sizeBytes: 60 * 1024 * 1024,
          kind: 'file',
          sha256: '0'.repeat(64),
          createdAt: 1000
        })
        ids.push(id)
      }
      const session = await sessions.createSession({ workspaceId })
      await assert.rejects(sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi', attachments: ids }))
    } finally {
      db.close()
    }
  })

  it('keeps attachment bytes out of message content for AI readers', async () => {
    const { db, dir, sessions, attachments, workspaceId } = openHarness()
    try {
      const source = join(dir, 'secret.txt')
      writeFileSync(source, 'TOP-SECRET-ATTACHMENT-BYTES')
      const [stored] = await attachments.chooseAttachments(workspaceId, [source])
      assert.ok(stored !== undefined)
      const session = await sessions.createSession({ workspaceId })
      const result = await sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'see attached', attachments: [stored.id] })
      assert.equal(result.message.content, 'see attached')
      assert.ok(!result.message.content.includes('TOP-SECRET'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
