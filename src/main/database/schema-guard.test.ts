import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { DatabaseError, NewerSchemaError } from './errors'
import { getUserVersion, migrations, runMigrations, validateMigrations } from './migrations/index'
import { StarkDatabase } from './database'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function readCorruptMarker(file: string): string {
  return readFileSync(file, 'utf8')
}

describe('schema guard (Stage 30)', () => {
  it('refuses to open a database newer than this build supports', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.equal(getUserVersion(db), 18)
      assert.throws(
        () => runMigrations(db, migrations.filter((migration) => migration.version <= 17)),
        (error: unknown) =>
          error instanceof NewerSchemaError &&
          String((error as Error).message).includes('newer version of STARK')
      )
    } finally {
      db.close()
    }
  })

  it('never migrates backwards: stored version stays intact after refusal', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.throws(() =>
        runMigrations(
          db,
          migrations.filter((migration) => migration.version <= 5)
        )
      )
      assert.equal(getUserVersion(db), 18)
    } finally {
      db.close()
    }
  })

  it('fails safe on a corrupt SQLite file with no delete, overwrite, or repair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-corrupt-db-'))
    try {
      const file = join(dir, 'corrupt.db')
      writeFileSync(file, 'this is not a sqlite database file at all', 'utf8')
      const database = new StarkDatabase()
      assert.throws(() => database.initialize(file), DatabaseError)
      assert.equal(database.isOpen(), false)
      // The corrupt file is left untouched for deliberate future recovery.
      assert.equal(readCorruptMarker(file), 'this is not a sqlite database file at all')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failing migration leaves the previous version intact', () => {
    const db = openFresh()
    try {
      runMigrations(
        db,
        migrations.filter((migration) => migration.version <= 10)
      )
      assert.equal(getUserVersion(db), 10)
      assert.throws(() =>
        runMigrations(db, [
          ...migrations.filter((migration) => migration.version <= 10),
          { version: 11, name: 'boom', up(): void { throw new Error('boom') } }
        ])
      )
      assert.equal(getUserVersion(db), 10)
    } finally {
      db.close()
    }
  })

  it('migration registry stays ordered exactly once, 1..18, append-only', () => {
    validateMigrations(migrations)
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
    )
    const names = migrations.map((migration) => migration.name)
    assert.equal(new Set(names).size, names.length)
    for (const name of names) {
      assert.ok(name !== '')
    }
  })
})
