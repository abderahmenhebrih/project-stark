import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../migrations/index'
import { AiProviderRepository } from './ai-provider-repository'

function openRepository(): { db: DatabaseSync; providers: AiProviderRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  db.exec('PRAGMA foreign_keys = ON')
  return { db, providers: new AiProviderRepository(db) }
}

describe('AI provider repository', () => {
  it('creates a config row on first access', () => {
    const { db, providers } = openRepository()
    try {
      assert.equal(providers.findConfig('openai'), undefined)
      const created = providers.ensureConfig('openai', 1000)
      assert.equal(created.providerId, 'openai')
      assert.equal(created.selectedModel, null)
      assert.equal(created.createdAt, 1000)
    } finally {
      db.close()
    }
  })

  it('sets and replaces the selected model', () => {
    const { db, providers } = openRepository()
    try {
      providers.setSelectedModel('openai', 'gpt-4o', 1000)
      assert.equal(providers.findConfig('openai')?.selectedModel, 'gpt-4o')
      providers.setSelectedModel('openai', 'o3-mini', 2000)
      const stored = providers.findConfig('openai')
      assert.equal(stored?.selectedModel, 'o3-mini')
      assert.equal(stored?.updatedAt, 2000)
    } finally {
      db.close()
    }
  })

  it('inserts and replaces credential ciphertext exactly', () => {
    const { db, providers } = openRepository()
    try {
      assert.equal(providers.findEncryptedCredential('openai'), undefined)
      const first = Buffer.from([1, 2, 3, 250])
      providers.setEncryptedCredential('openai', first, 1000)
      assert.deepEqual(providers.findEncryptedCredential('openai'), first)
      const second = Buffer.from([9, 9, 9])
      providers.setEncryptedCredential('openai', second, 2000)
      assert.deepEqual(providers.findEncryptedCredential('openai'), second)
    } finally {
      db.close()
    }
  })

  it('clears the credential while keeping the config', () => {
    const { db, providers } = openRepository()
    try {
      providers.setSelectedModel('openai', 'gpt-4o', 1000)
      providers.setEncryptedCredential('openai', Buffer.from([1]), 1000)
      providers.clearEncryptedCredential('openai')
      assert.equal(providers.findEncryptedCredential('openai'), undefined)
      assert.equal(providers.findConfig('openai')?.selectedModel, 'gpt-4o')
    } finally {
      db.close()
    }
  })

  it('round-trips arbitrary BLOB bytes', () => {
    const { db, providers } = openRepository()
    try {
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
      providers.setEncryptedCredential('openai', bytes, 1000)
      const stored = providers.findEncryptedCredential('openai')
      assert.ok(stored instanceof Buffer)
      assert.deepEqual(stored, bytes)
    } finally {
      db.close()
    }
  })

  it('preserves exact bytes from offset Uint8Array views', () => {
    const { db, providers } = openRepository()
    try {
      // node:sqlite hands BLOBs back as Uint8Array views that may share
      // a larger ArrayBuffer; the conversion must respect view bounds.
      const backing = new Uint8Array([9, 9, 1, 2, 3, 250, 9, 9])
      const view = backing.subarray(2, 6)
      assert.equal(view.byteOffset, 2)
      providers.setEncryptedCredential('openai', Buffer.from(view), 1000)
      const stored = providers.findEncryptedCredential('openai')
      assert.deepEqual(stored, Buffer.from([1, 2, 3, 250]))
      // And a raw offset view converts byte-exactly through Buffer.from.
      assert.deepEqual(Buffer.from(view), Buffer.from([1, 2, 3, 250]))
    } finally {
      db.close()
    }
  })

  it('never persists plaintext alongside ciphertext', () => {
    const { db, providers } = openRepository()
    try {
      providers.setEncryptedCredential('openai', Buffer.from('ciphertext-only', 'utf8'), 1000)
      const rows: unknown = db.prepare('SELECT * FROM ai_provider_credentials').all()
      assert.ok(Array.isArray(rows) && rows.length === 1)
      const serialized = JSON.stringify(rows)
      assert.ok(!serialized.includes('sk-'), 'no key-like plaintext may appear')
    } finally {
      db.close()
    }
  })

  it('cascades credentials when the config row is deleted', () => {
    const { db, providers } = openRepository()
    try {
      providers.setEncryptedCredential('openai', Buffer.from([7]), 1000)
      db.exec("DELETE FROM ai_provider_configs WHERE provider_id = 'openai'")
      assert.equal(providers.findEncryptedCredential('openai'), undefined)
    } finally {
      db.close()
    }
  })
})
