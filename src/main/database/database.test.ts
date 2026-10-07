import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseError } from './errors'
import { StarkDatabase } from './database'
import type { Migration } from './types'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'stark-db-test-'))
}

describe('StarkDatabase lifecycle', () => {
  it('initializes in-memory with schema version 1', () => {
    const database = new StarkDatabase()
    try {
      database.initialize(':memory:')
      assert.equal(database.isOpen(), true)
      assert.equal(database.getSchemaVersion(), 1)
      assert.equal(database.readStoredSchemaVersion(), 1)
    } finally {
      database.close()
    }
  })

  it('exposes a working key/value repository', () => {
    const database = new StarkDatabase()
    try {
      database.initialize(':memory:')
      database.getKeyValue().set('hello', { world: true })
      assert.deepEqual(database.getKeyValue().get('hello'), { world: true })
    } finally {
      database.close()
    }
  })

  it('close is idempotent and resets state', () => {
    const database = new StarkDatabase()
    database.close()
    database.initialize(':memory:')
    database.close()
    database.close()
    assert.equal(database.isOpen(), false)
    assert.equal(database.getSchemaVersion(), 0)
    assert.throws(() => database.getKeyValue(), DatabaseError)
    assert.throws(() => database.readStoredSchemaVersion(), DatabaseError)
  })

  it('repository access before initialization throws', () => {
    const database = new StarkDatabase()
    assert.throws(() => database.getKeyValue(), DatabaseError)
  })

  it('double initialization is rejected', () => {
    const database = new StarkDatabase()
    try {
      database.initialize(':memory:')
      assert.throws(() => database.initialize(':memory:'), DatabaseError)
    } finally {
      database.close()
    }
  })

  it('failed initialization leaves no open connection behind', () => {
    const database = new StarkDatabase()
    const failing: Migration = {
      version: 1,
      name: 'boom',
      up(): void {
        throw new Error('boom')
      }
    }
    assert.throws(() => database.initialize(':memory:', [failing]), DatabaseError)
    assert.equal(database.isOpen(), false)
  })

  it('file-backed database persists across restarts', () => {
    const dir = makeTempDir()
    try {
      const file = join(dir, 'restart.db')
      const first = new StarkDatabase()
      try {
        first.initialize(file)
        first.getKeyValue().set('survive', [1, 2, 3])
        assert.equal(first.getSchemaVersion(), 1)
      } finally {
        first.close()
      }
      const second = new StarkDatabase()
      try {
        second.initialize(file)
        assert.equal(second.getSchemaVersion(), 1)
        assert.deepEqual(second.getKeyValue().get('survive'), [1, 2, 3])
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
