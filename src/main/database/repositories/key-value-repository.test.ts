import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { CorruptValueError, DatabaseError } from '../errors'
import { migrations, runMigrations } from '../migrations/index'
import type { JsonValue } from '../types'
import { KeyValueRepository } from './key-value-repository'

function openRepository(): { db: DatabaseSync; repo: KeyValueRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, repo: new KeyValueRepository(db) }
}

describe('KeyValueRepository', () => {
  it('set then get round-trips JSON values', () => {
    const { db, repo } = openRepository()
    try {
      const cases: Array<[string, JsonValue]> = [
        ['s', 'hello'],
        ['i', 42],
        ['f', 3.14],
        ['t', true],
        ['fl', false],
        ['n', null],
        ['o', { a: 1, nested: { list: [1, 'two', false, null] } }],
        ['a', [1, 'two', { three: 3 }, [4], null]]
      ]
      for (const [key, value] of cases) {
        repo.set(key, value)
        assert.deepEqual(repo.get(key), value)
      }
    } finally {
      db.close()
    }
  })

  it('set overwrites the previous value', () => {
    const { db, repo } = openRepository()
    try {
      repo.set('k', 'first')
      repo.set('k', { second: [2] })
      assert.deepEqual(repo.get('k'), { second: [2] })
    } finally {
      db.close()
    }
  })

  it('has reports existing and missing keys', () => {
    const { db, repo } = openRepository()
    try {
      repo.set('present', 1)
      assert.equal(repo.has('present'), true)
      assert.equal(repo.has('absent'), false)
    } finally {
      db.close()
    }
  })

  it('delete removes existing keys and reports missing ones', () => {
    const { db, repo } = openRepository()
    try {
      repo.set('gone', 'x')
      assert.equal(repo.delete('gone'), true)
      assert.equal(repo.get('gone'), undefined)
      assert.equal(repo.has('gone'), false)
      assert.equal(repo.delete('never-there'), false)
    } finally {
      db.close()
    }
  })

  it('empty keys are rejected', () => {
    const { db, repo } = openRepository()
    try {
      assert.throws(() => repo.get(''), DatabaseError)
      assert.throws(() => repo.set('', 'x'), DatabaseError)
      assert.throws(() => repo.has(''), DatabaseError)
      assert.throws(() => repo.delete(''), DatabaseError)
    } finally {
      db.close()
    }
  })

  it('non-JSON-serializable values are rejected', () => {
    const { db, repo } = openRepository()
    try {
      const bad: unknown[] = [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        () => {},
        Symbol('s'),
        10n,
        new Date(),
        { nested: undefined },
        [1, Number.NaN]
      ]
      for (const value of bad) {
        assert.throws(() => repo.set('k', value as JsonValue), DatabaseError)
      }
      assert.equal(repo.has('k'), false)
    } finally {
      db.close()
    }
  })

  it('corrupt stored JSON produces a controlled error', () => {
    const { db, repo } = openRepository()
    try {
      db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('broken', '{not-json', 0)")
      assert.throws(() => repo.get('broken'), CorruptValueError)
    } finally {
      db.close()
    }
  })
})
