import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { InvalidDisplayNameError } from './errors'
import { PROFILE_STORAGE_KEY } from './profile-schema'
import { ProfileService } from './profile-service'

function openService(): { db: DatabaseSync; service: ProfileService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, service: new ProfileService(new KeyValueRepository(db)) }
}

describe('ProfileService', () => {
  it('no stored profile returns null', async () => {
    const { db, service } = openService()
    try {
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })

  it('a valid profile persists and reads back', async () => {
    const { db, service } = openService()
    try {
      assert.deepEqual(await service.setDisplayName('Abdou'), { displayName: 'Abdou' })
      assert.deepEqual(await service.getProfile(), { displayName: 'Abdou' })
    } finally {
      db.close()
    }
  })

  it('profile survives database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-profile-test-'))
    try {
      const file = join(dir, 'profile.db')
      const first = new DatabaseSync(file)
      try {
        runMigrations(first, migrations)
        await new ProfileService(new KeyValueRepository(first)).setDisplayName('Élodie')
      } finally {
        first.close()
      }
      const second = new DatabaseSync(file)
      try {
        runMigrations(second, migrations)
        assert.deepEqual(await new ProfileService(new KeyValueRepository(second)).getProfile(), {
          displayName: 'Élodie'
        })
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leading and trailing whitespace is trimmed', async () => {
    const { db, service } = openService()
    try {
      assert.deepEqual(await service.setDisplayName('  Abdou GXD  '), { displayName: 'Abdou GXD' })
    } finally {
      db.close()
    }
  })

  it('Unicode names are preserved', async () => {
    const { db, service } = openService()
    try {
      for (const name of ['Abdou', 'عبد الرحمن', 'Élodie', '山田', 'A']) {
        assert.deepEqual(await service.setDisplayName(name), { displayName: name })
        assert.deepEqual(await service.getProfile(), { displayName: name })
      }
    } finally {
      db.close()
    }
  })

  it('one-character and 40-character names are accepted', async () => {
    const { db, service } = openService()
    try {
      assert.deepEqual(await service.setDisplayName('A'), { displayName: 'A' })
      const forty = 'x'.repeat(40)
      assert.deepEqual(await service.setDisplayName(forty), { displayName: forty })
    } finally {
      db.close()
    }
  })

  it('names longer than 40 characters are rejected', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.setDisplayName('x'.repeat(41)), InvalidDisplayNameError)
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })

  it('empty names are rejected', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.setDisplayName(''), InvalidDisplayNameError)
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })

  it('whitespace-only names are rejected', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.setDisplayName('     '), InvalidDisplayNameError)
      await assert.rejects(service.setDisplayName('\u200b\u200b\u200b'), InvalidDisplayNameError)
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })

  it('non-string payloads are rejected', async () => {
    const { db, service } = openService()
    try {
      for (const bad of [null, 42, true, { displayName: 'Abdou' }, ['Abdou'], undefined]) {
        await assert.rejects(service.setDisplayName(bad), InvalidDisplayNameError)
      }
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })

  it('control characters are rejected', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.setDisplayName('Ab\ndou'), InvalidDisplayNameError)
      await assert.rejects(service.setDisplayName('Ab\tdou'), InvalidDisplayNameError)
      await assert.rejects(service.setDisplayName('Ab\u0001dou'), InvalidDisplayNameError)
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })

  it('invalid persisted profile is treated as missing, not fatal', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      db.exec(`INSERT INTO key_value (key, value, updated_at) VALUES ('${PROFILE_STORAGE_KEY}', '{broken', 0)`)
      assert.equal(await new ProfileService(new KeyValueRepository(db)).getProfile(), null)
    } finally {
      db.close()
    }
    const wrongShape = new DatabaseSync(':memory:')
    try {
      runMigrations(wrongShape, migrations)
      const repository = new KeyValueRepository(wrongShape)
      repository.set(PROFILE_STORAGE_KEY, { displayName: '   ' })
      assert.equal(await new ProfileService(repository).getProfile(), null)
    } finally {
      wrongShape.close()
    }
  })

  it('persistence contains the normalized name', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const repository = new KeyValueRepository(db)
      const service = new ProfileService(repository)
      await service.setDisplayName('  Abdou   GXD  ')
      assert.deepEqual(repository.get(PROFILE_STORAGE_KEY), { displayName: 'Abdou   GXD' })
    } finally {
      db.close()
    }
  })

  it('an invalid set does not overwrite an existing valid profile', async () => {
    const { db, service } = openService()
    try {
      await service.setDisplayName('Abdou')
      await assert.rejects(service.setDisplayName(''), InvalidDisplayNameError)
      await assert.rejects(service.setDisplayName({ displayName: 'Nope' }), InvalidDisplayNameError)
      assert.deepEqual(await service.getProfile(), { displayName: 'Abdou' })
    } finally {
      db.close()
    }
  })

  it('clearProfile removes the stored profile', async () => {
    const { db, service } = openService()
    try {
      await service.setDisplayName('Abdou')
      await service.clearProfile()
      assert.equal(await service.getProfile(), null)
    } finally {
      db.close()
    }
  })
})
