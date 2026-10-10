import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { getUserVersion, migrations, runMigrations } from './index'
import { migration018CloudAccount } from './018-cloud-account'
import { migration019MessageAttachments } from './019-message-attachments'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

describe('migration 19 (message attachments)', () => {
  it('fresh database migrates to schema version 19', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 19)
      assert.equal(getUserVersion(db), 19)
      assert.ok(tableExists(db, 'chat_attachments'))
      assert.ok(tableExists(db, 'message_attachments'))
    } finally {
      db.close()
    }
  })

  it('v18 database upgrades to v19 preserving existing rows', () => {
    const db = openFresh()
    try {
      const without19 = migrations.filter((migration) => migration.version <= 18)
      assert.equal(runMigrations(db, without19), 18)
      db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{\"a\":1}', 1)")
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 's', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      assert.equal(runMigrations(db, migrations), 19)
      assert.equal(getUserVersion(db), 19)
      const workspace: unknown = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()
      assert.equal(JSON.stringify(workspace), JSON.stringify({ n: 1 }))
      const message: unknown = db.prepare('SELECT COUNT(*) AS n FROM coding_messages').get()
      assert.equal(JSON.stringify(message), JSON.stringify({ n: 1 }))
      assert.ok(tableExists(db, 'chat_attachments'))
      assert.ok(tableExists(db, 'message_attachments'))
    } finally {
      db.close()
    }
  })

  it('migration 19 creates attachment tables with kind checks', () => {
    const db = openFresh()
    try {
      runMigrations(db, [migrations[0], migration018CloudAccount, migration019MessageAttachments].filter((m) => m.version <= 19))
      assert.ok(tableExists(db, 'chat_attachments'))
      assert.ok(tableExists(db, 'message_attachments'))
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(
        "INSERT INTO chat_attachments (id, original_name, mime_type, size_bytes, kind, sha256, created_at) " +
          "VALUES ('" +
          'a'.repeat(32) +
          "', 'photo.png', 'image/png', 12, 'image', '" +
          'b'.repeat(64) +
          "', 1)"
      )
      db.exec("DELETE FROM chat_attachments WHERE id = '" + 'a'.repeat(32) + "'")
      // Invalid kind rejected at the database boundary.
      assert.throws(() =>
        db.exec(
          "INSERT INTO chat_attachments (id, original_name, mime_type, size_bytes, kind, sha256, created_at) " +
            "VALUES ('" +
            'c'.repeat(32) +
            "', 'x', 'text/plain', 1, 'video', '" +
            'd'.repeat(64) +
            "', 1)"
        )
      )
    } finally {
      db.close()
    }
  })

  it('rerunning v19 is idempotent and keeps attachment rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec(
        "INSERT INTO chat_attachments (id, original_name, mime_type, size_bytes, kind, sha256, created_at) " +
          "VALUES ('" +
          'e'.repeat(32) +
          "', 'doc.pdf', 'application/pdf', 9, 'file', '" +
          'f'.repeat(64) +
          "', 1)"
      )
      assert.equal(runMigrations(db, migrations), 19)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM chat_attachments').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('migrations remain registered in ascending order ending at 19', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    )
  })
})
