import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { DatabaseError, MigrationError } from '../errors'
import type { Migration } from '../types'
import { getUserVersion, migrations, runMigrations, validateMigrations } from './index'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

describe('migrations', () => {
  it('brand new database starts at schema version 0', () => {
    const db = openFresh()
    try {
      assert.equal(getUserVersion(db), 0)
    } finally {
      db.close()
    }
  })

  it('migration 1 applies and sets schema version to 1', () => {
    const db = openFresh()
    try {
      const version = runMigrations(db, migrations)
      assert.equal(version, 1)
      assert.equal(getUserVersion(db), 1)
    } finally {
      db.close()
    }
  })

  it('migration 1 creates the key_value table', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      const row: unknown = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'key_value'")
        .get()
      assert.notEqual(row, undefined)
    } finally {
      db.close()
    }
  })

  it('running migrations again is idempotent', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 1)
      assert.equal(runMigrations(db, migrations), 1)
      assert.equal(getUserVersion(db), 1)
    } finally {
      db.close()
    }
  })

  it('duplicate migration versions are rejected', () => {
    const dupe: Migration = { version: 1, name: 'dupe', up(): void {} }
    assert.throws(() => validateMigrations([migrations[0], dupe]), DatabaseError)
  })

  it('invalid versions are rejected', () => {
    const zero: Migration = { version: 0, name: 'zero', up(): void {} }
    const negative: Migration = { version: -2, name: 'negative', up(): void {} }
    const fractional: Migration = { version: 1.5, name: 'fractional', up(): void {} }
    assert.throws(() => validateMigrations([zero]), DatabaseError)
    assert.throws(() => validateMigrations([negative]), DatabaseError)
    assert.throws(() => validateMigrations([fractional]), DatabaseError)
  })

  it('out-of-order migrations are rejected', () => {
    const second: Migration = { version: 2, name: 'second', up(): void {} }
    assert.throws(() => validateMigrations([second, migrations[0]]), DatabaseError)
  })

  it('a failing migration does not mark the schema as upgraded', () => {
    const db = openFresh()
    try {
      const failing: Migration = {
        version: 1,
        name: 'boom',
        up(): void {
          throw new Error('boom')
        }
      }
      assert.throws(() => runMigrations(db, [failing]), MigrationError)
      assert.equal(getUserVersion(db), 0)
    } finally {
      db.close()
    }
  })

  it('a partially applied migration rolls back its schema changes', () => {
    const db = openFresh()
    try {
      const partial: Migration = {
        version: 1,
        name: 'partial',
        up(target): void {
          target.exec('CREATE TABLE partial_table (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(() => runMigrations(db, [partial]), MigrationError)
      assert.equal(getUserVersion(db), 0)
      const row: unknown = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_table'")
        .get()
      assert.equal(row, undefined)
    } finally {
      db.close()
    }
  })
})
