import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../migrations/index'
import { CodingSessionRepository } from './coding-session-repository'
import { WorkspaceRepository } from './workspace-repository'

function openRepositories(): { db: DatabaseSync; sessions: CodingSessionRepository; workspaces: WorkspaceRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  db.exec('PRAGMA foreign_keys = ON')
  return { db, sessions: new CodingSessionRepository(db), workspaces: new WorkspaceRepository(db) }
}

function seedSession(sessions: CodingSessionRepository, workspaces: WorkspaceRepository): { sessionId: number } {
  const workspaceId = workspaces.create({ rootPath: 'w', displayName: 'w', now: 1000 }).id
  const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
  return { sessionId }
}

describe('message context repository', () => {
  it('appends a message with context atomically', () => {
    const { db, sessions, workspaces } = openRepositories()
    try {
      const { sessionId } = seedSession(sessions, workspaces)
      const { messageId } = sessions.appendMessageWithContext(
        { sessionId, role: 'user', content: 'hello', now: 2000, retitle: null },
        [
          {
            kind: 'manual-note',
            label: 'Manual note',
            relativePath: null,
            lineStart: null,
            lineEnd: null,
            content: 'remember this',
            contentBytes: 13,
            createdAt: 2000
          },
          {
            kind: 'file-excerpt',
            label: 'a.ts · lines 1–2',
            relativePath: 'a.ts',
            lineStart: 1,
            lineEnd: 2,
            content: 'const x = 1\n',
            contentBytes: 12,
            createdAt: 2000
          }
        ]
      )
      const rows = sessions.listContextForMessage(messageId)
      assert.equal(rows.length, 2)
      assert.equal(rows[0]?.kind, 'manual-note')
      assert.equal(rows[0]?.relativePath, null)
      assert.equal(rows[1]?.kind, 'file-excerpt')
      assert.equal(rows[1]?.relativePath, 'a.ts')
      assert.equal(rows[1]?.lineStart, 1)
      assert.equal(rows[1]?.lineEnd, 2)
      assert.equal(sessions.findSessionById(sessionId)?.updatedAt, 2000)
    } finally {
      db.close()
    }
  })

  it('rolls back message and context together on failure', () => {
    const { db, sessions, workspaces } = openRepositories()
    try {
      const { sessionId } = seedSession(sessions, workspaces)
      // Invalid kind violates the CHECK: neither the message nor any
      // context row may survive.
      assert.throws(() =>
        sessions.appendMessageWithContext({ sessionId, role: 'user', content: 'hello', now: 2000, retitle: null }, [
          {
            kind: 'bogus-kind',
            label: 'x',
            relativePath: null,
            lineStart: null,
            lineEnd: null,
            content: 'x',
            contentBytes: 1,
            createdAt: 2000
          } as never
        ])
      )
      assert.equal(sessions.listMessagesNewestFirst(sessionId, 10, null).length, 0)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM message_context_items').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
      assert.equal(sessions.findSessionById(sessionId)?.updatedAt, 1000)
    } finally {
      db.close()
    }
  })

  it('returns empty context for messages without attachments', () => {
    const { db, sessions, workspaces } = openRepositories()
    try {
      const { sessionId } = seedSession(sessions, workspaces)
      const { messageId } = sessions.appendMessage({ sessionId, role: 'user', content: 'plain', now: 2000, retitle: null })
      assert.deepEqual(sessions.listContextForMessage(messageId), [])
    } finally {
      db.close()
    }
  })

  it('groups context rows per message in one query', () => {
    const { db, sessions, workspaces } = openRepositories()
    try {
      const { sessionId } = seedSession(sessions, workspaces)
      const first = sessions.appendMessageWithContext(
        { sessionId, role: 'user', content: 'one', now: 2000, retitle: null },
        [
          {
            kind: 'manual-note',
            label: 'a',
            relativePath: null,
            lineStart: null,
            lineEnd: null,
            content: 'a',
            contentBytes: 1,
            createdAt: 2000
          },
          {
            kind: 'manual-note',
            label: 'b',
            relativePath: null,
            lineStart: null,
            lineEnd: null,
            content: 'b',
            contentBytes: 1,
            createdAt: 2000
          }
        ]
      )
      const second = sessions.appendMessage({ sessionId, role: 'assistant', content: 'two', now: 3000, retitle: null })
      const grouped = sessions.listContextForMessages([first.messageId, second.messageId, 9999])
      assert.equal(grouped.get(first.messageId)?.length, 2)
      assert.equal(grouped.has(second.messageId), false)
      assert.equal(grouped.size, 1)
      assert.deepEqual(sessions.listContextForMessages([]), new Map())
    } finally {
      db.close()
    }
  })

  it('rejects malformed stored context rows safely', () => {
    const { db, sessions, workspaces } = openRepositories()
    try {
      const { sessionId } = seedSession(sessions, workspaces)
      const { messageId } = sessions.appendMessage({ sessionId, role: 'user', content: 'x', now: 2000, retitle: null })
      db.exec(
        `INSERT INTO message_context_items (id, message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) ` +
          `VALUES (5000, ${messageId}, 'manual-note', 'x', NULL, NULL, NULL, 'x', 1, 2000)`
      )
      // SQLite is dynamically typed: corrupt the column type directly.
      db.exec(`UPDATE message_context_items SET content_bytes = 'not-a-number' WHERE id = 5000`)
      assert.throws(() => sessions.listContextForMessage(messageId), /stored message context row is invalid/)
    } finally {
      db.close()
    }
  })
})
