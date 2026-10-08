import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { MigrationError } from '../errors'
import type { Migration } from '../types'
import { getUserVersion, migrations, runMigrations } from './index'
import { migration001Initial } from './001-initial'
import { migration002Workspaces } from './002-workspaces'
import { migration003ChangeTransactions } from './003-change-transactions'
import { migration004CodingSessions } from './004-coding-sessions'
import { StarkDatabase } from '../database'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return row !== undefined
}

function indexExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name)
  return row !== undefined
}

function seedV3(db: DatabaseSync): void {
  assert.equal(runMigrations(db, [migration001Initial, migration002Workspaces, migration003ChangeTransactions]), 3)
  db.exec(
    "INSERT INTO key_value (key, value, updated_at) VALUES " +
      "('stark.settings', '{\"appearance\":\"dark\"}', 1), " +
      "('stark.profile', '{\"displayName\":\"Abdou\"}', 2)"
  )
  db.exec(
    "INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) " +
      "VALUES ('C:\\proj\\a', 'a', 10, 20)"
  )
  db.exec(
    "INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) " +
      "VALUES (1, 'pending', 5, 5)"
  )
}

describe('migration 4 (coding sessions)', () => {
  it('fresh DB migrates through v6 with session tables', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 13)
      assert.equal(getUserVersion(db), 13)
    } finally {
      db.close()
    }
  })

  it('v3 database upgrades through v6', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, [migration001Initial, migration002Workspaces, migration003ChangeTransactions]), 3)
      assert.equal(runMigrations(db, migrations), 13)
      assert.equal(getUserVersion(db), 13)
    } finally {
      db.close()
    }
  })

  it('preserves key_value rows across v3 to v5', () => {
    const db = openFresh()
    try {
      seedV3(db)
      assert.equal(runMigrations(db, migrations), 13)
      const settings: unknown = db.prepare("SELECT value FROM key_value WHERE key = 'stark.settings'").get()
      const profile: unknown = db.prepare("SELECT value FROM key_value WHERE key = 'stark.profile'").get()
      assert.equal(JSON.stringify(settings), JSON.stringify({ value: '{"appearance":"dark"}' }))
      assert.equal(JSON.stringify(profile), JSON.stringify({ value: '{"displayName":"Abdou"}' }))
    } finally {
      db.close()
    }
  })

  it('preserves workspaces across v3 to v5', () => {
    const db = openFresh()
    try {
      seedV3(db)
      assert.equal(runMigrations(db, migrations), 13)
      const workspace: unknown = db
        .prepare('SELECT root_path, display_name FROM workspaces WHERE root_path = ?')
        .get('C:\\proj\\a')
      assert.equal(JSON.stringify(workspace), JSON.stringify({ root_path: 'C:\\proj\\a', display_name: 'a' }))
    } finally {
      db.close()
    }
  })

  it('preserves change_transactions history across v3 to v5', () => {
    const db = openFresh()
    try {
      seedV3(db)
      assert.equal(runMigrations(db, migrations), 13)
      const count: unknown = db.prepare("SELECT COUNT(*) AS n FROM change_transactions WHERE status = 'pending'").get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('creates coding_sessions with its workspace index', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'coding_sessions'))
      assert.ok(indexExists(db, 'idx_coding_sessions_workspace_updated'))
    } finally {
      db.close()
    }
  })

  it('creates coding_messages with its session index', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'coding_messages'))
      assert.ok(indexExists(db, 'idx_coding_messages_session_id'))
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys on session and message rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (999, 'x', 1, 1)")
      )
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
      assert.throws(() =>
        db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (999, 'user', 'hi', 1)")
      )
    } finally {
      db.close()
    }
  })

  it('accepts user and assistant roles but rejects anything else', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'assistant', 'hello', 2)")
      assert.throws(() =>
        db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'system', 'x', 3)")
      )
      assert.throws(() =>
        db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'tool', 'x', 3)")
      )
    } finally {
      db.close()
    }
  })

  it('rerunning through v6 is idempotent and keeps session rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      assert.equal(runMigrations(db, migrations), 13)
      const sessions: unknown = db.prepare('SELECT COUNT(*) AS n FROM coding_sessions').get()
      const messages: unknown = db.prepare('SELECT COUNT(*) AS n FROM coding_messages').get()
      assert.equal(JSON.stringify(sessions), JSON.stringify({ n: 1 }))
      assert.equal(JSON.stringify(messages), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v4 migration rolls back without marking version 4', () => {
    const db = openFresh()
    try {
      runMigrations(db, [migration001Initial, migration002Workspaces, migration003ChangeTransactions])
      const failingV4: Migration = {
        version: 4,
        name: 'broken-sessions',
        up(target): void {
          target.exec('CREATE TABLE coding_sessions (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(
        () =>
          runMigrations(db, [
            migration001Initial,
            migration002Workspaces,
            migration003ChangeTransactions,
            failingV4
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 3)
      assert.equal(tableExists(db, 'coding_sessions'), false)
    } finally {
      db.close()
    }
  })

  it('migration 4 remains registered before migration 5', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    )
    assert.equal(migration004CodingSessions.version, 4)
  })

  it('file-backed sessions and messages survive a database restart at v6', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-sessions-restart-'))
    try {
      const file = join(dir, 'restart.db')
      const first = new StarkDatabase()
      let workspaceId = 0
      let sessionId = 0
      try {
        first.initialize(file)
        assert.equal(first.getSchemaVersion(), 13)
        workspaceId = first.getWorkspaces().create({ rootPath: 'w', displayName: 'w', now: 100 }).id
        sessionId = first.getCodingSessions().createSession({ workspaceId, title: 'New session', now: 200 })
        first.getCodingSessions().appendMessage({
          sessionId,
          role: 'user',
          content: 'Hello STARK',
          now: 300,
          retitle: { expectedTitle: 'New session', newTitle: 'Hello STARK' }
        })
      } finally {
        first.close()
      }
      const second = new StarkDatabase()
      try {
        second.initialize(file)
        assert.equal(second.getSchemaVersion(), 13)
        assert.equal(second.readStoredSchemaVersion(), 13)
        const reopened = second.getCodingSessions().findSessionById(sessionId)
        assert.equal(reopened?.title, 'Hello STARK')
        assert.equal(reopened?.updatedAt, 300)
        const messages = second.getCodingSessions().listMessagesNewestFirst(sessionId, 100, null)
        assert.equal(messages.length, 1)
        assert.equal(messages[0]?.content, 'Hello STARK')
        assert.equal(messages[0]?.role, 'user')
        // No auto-created sessions on reopen: exactly the one row.
        const listed = second.getCodingSessions().listRecentSessions(workspaceId, 50)
        assert.equal(listed.length, 1)
        assert.equal(listed[0]?.id, sessionId)
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
