import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../migrations/index'
import { CodingSessionRepository } from './coding-session-repository'
import { WorkspaceRepository } from './workspace-repository'

function openRepos(): { db: DatabaseSync; sessions: CodingSessionRepository; workspaces: WorkspaceRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  db.exec('PRAGMA foreign_keys = ON')
  return { db, sessions: new CodingSessionRepository(db), workspaces: new WorkspaceRepository(db) }
}

function createWorkspace(workspaces: WorkspaceRepository, rootPath: string): number {
  const created = workspaces.create({ rootPath, displayName: rootPath, now: 1000 })
  return created.id
}

describe('coding session repository', () => {
  it('creates a session with the supplied title', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w1')
      const id = sessions.createSession({ workspaceId, title: 'New session', now: 2000 })
      const stored = sessions.findSessionById(id)
      assert.equal(stored?.workspaceId, workspaceId)
      assert.equal(stored?.title, 'New session')
      assert.equal(stored?.createdAt, 2000)
      assert.equal(stored?.updatedAt, 2000)
    } finally {
      db.close()
    }
  })

  it('rejects sessions for unknown workspaces at the FK boundary', () => {
    const { db, sessions } = openRepos()
    try {
      assert.throws(() => sessions.createSession({ workspaceId: 999, title: 'New session', now: 1 }))
    } finally {
      db.close()
    }
  })

  it('lists only the requested workspace newest-first with id tiebreak', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const first = createWorkspace(workspaces, 'a')
      const second = createWorkspace(workspaces, 'b')
      const one = sessions.createSession({ workspaceId: first, title: 'one', now: 100 })
      const two = sessions.createSession({ workspaceId: first, title: 'two', now: 100 })
      sessions.createSession({ workspaceId: second, title: 'other', now: 500 })
      const listed = sessions.listRecentSessions(first, 50)
      assert.deepEqual(
        listed.map((entry) => entry.id),
        [two, one]
      )
      assert.ok(listed.every((entry) => entry.workspaceId === first))
    } finally {
      db.close()
    }
  })

  it('caps the session list at the requested limit', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      for (let index = 0; index < 55; index += 1) {
        sessions.createSession({ workspaceId, title: `s${String(index)}`, now: 1000 + index })
      }
      assert.equal(sessions.listRecentSessions(workspaceId, 50).length, 50)
    } finally {
      db.close()
    }
  })

  it('finds sessions by id and misses unknown ids', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const id = sessions.createSession({ workspaceId, title: 't', now: 1 })
      assert.notEqual(sessions.findSessionById(id), undefined)
      assert.equal(sessions.findSessionById(id + 999), undefined)
    } finally {
      db.close()
    }
  })

  it('appends a user message with exact content preserved', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 'New session', now: 1000 })
      const content = '  Hello\n\tSTARK caf\u00e9  \nsecond line  '
      const { messageId, titleChanged } = sessions.appendMessage({
        sessionId,
        role: 'user',
        content,
        now: 2000,
        retitle: null
      })
      assert.equal(titleChanged, false)
      assert.equal(sessions.findMessageById(messageId)?.content, content)
      assert.equal(sessions.findMessageById(messageId)?.role, 'user')
      assert.equal(sessions.findSessionById(sessionId)?.updatedAt, 2000)
    } finally {
      db.close()
    }
  })

  it('retitles on first message only when the title is still New session', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 'New session', now: 1000 })
      const first = sessions.appendMessage({
        sessionId,
        role: 'user',
        content: 'Fix the auth middleware',
        now: 2000,
        retitle: { expectedTitle: 'New session', newTitle: 'Fix the auth middleware' }
      })
      assert.equal(first.titleChanged, true)
      assert.equal(sessions.findSessionById(sessionId)?.title, 'Fix the auth middleware')
      const second = sessions.appendMessage({
        sessionId,
        role: 'user',
        content: 'Second message retitle attempt',
        now: 3000,
        retitle: { expectedTitle: 'New session', newTitle: 'Second message retitle attempt' }
      })
      assert.equal(second.titleChanged, false)
      assert.equal(sessions.findSessionById(sessionId)?.title, 'Fix the auth middleware')
      assert.equal(sessions.findSessionById(sessionId)?.updatedAt, 3000)
    } finally {
      db.close()
    }
  })

  it('advances updatedAt on every append', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
      sessions.appendMessage({ sessionId, role: 'user', content: 'one', now: 1500, retitle: null })
      assert.equal(sessions.findSessionById(sessionId)?.updatedAt, 1500)
      sessions.appendMessage({ sessionId, role: 'user', content: 'two', now: 2500, retitle: null })
      assert.equal(sessions.findSessionById(sessionId)?.updatedAt, 2500)
    } finally {
      db.close()
    }
  })

  it('rolls back the message when the session touch fails', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
      db.exec('DELETE FROM coding_sessions WHERE id = 1')
      // FK violation on insert must leave no orphan message behind.
      assert.throws(() =>
        sessions.appendMessage({ sessionId, role: 'user', content: 'orphan', now: 2000, retitle: null })
      )
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM coding_messages').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('pages messages newest-first with a hasMore probe, returned oldest-first', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
      for (let index = 1; index <= 5; index += 1) {
        sessions.appendMessage({ sessionId, role: 'user', content: `m${String(index)}`, now: 1000 + index, retitle: null })
      }
      const latest = sessions.listMessagesNewestFirst(sessionId, 2, null)
      assert.equal(latest.length, 3)
      assert.deepEqual(
        latest.map((entry) => entry.content),
        ['m5', 'm4', 'm3']
      )
      const older = sessions.listMessagesNewestFirst(sessionId, 2, latest[latest.length - 1]?.id ?? null)
      assert.deepEqual(
        older.map((entry) => entry.content),
        ['m2', 'm1']
      )
      const empty = sessions.listMessagesNewestFirst(sessionId, 2, older[older.length - 1]?.id ?? null)
      assert.equal(empty.length, 0)
    } finally {
      db.close()
    }
  })

  it('keeps Unicode and multiline content byte-exact', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
      const content = 'line one\r\nline two\n\ttabbed caf\u00e9 \u{1F389}'
      const { messageId } = sessions.appendMessage({ sessionId, role: 'user', content, now: 2000, retitle: null })
      assert.equal(sessions.findMessageById(messageId)?.content, content)
    } finally {
      db.close()
    }
  })

  it('cascades sessions and messages when the workspace is deleted', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
      sessions.appendMessage({ sessionId, role: 'user', content: 'hi', now: 2000, retitle: null })
      db.exec('DELETE FROM workspaces WHERE id = 1')
      assert.equal(sessions.findSessionById(sessionId), undefined)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM coding_messages').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('cascades messages when the session row is deleted internally', () => {
    const { db, sessions, workspaces } = openRepos()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const sessionId = sessions.createSession({ workspaceId, title: 't', now: 1000 })
      sessions.appendMessage({ sessionId, role: 'user', content: 'hi', now: 2000, retitle: null })
      db.exec('DELETE FROM coding_sessions WHERE id = 1')
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM coding_messages').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })
})
