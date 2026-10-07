import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS } from '../../shared/settings/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { CorruptSettingsError, InvalidSettingsError } from './errors'
import { SETTINGS_STORAGE_KEY } from './settings-schema'
import { SettingsService } from './settings-service'

function openService(): { db: DatabaseSync; service: SettingsService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, service: new SettingsService(new KeyValueRepository(db)) }
}

const CANONICAL_DEFAULTS = {
  appearance: 'dark',
  reduceMotion: false,
  confirmBeforeDestructiveActions: true
} as const

describe('SettingsService', () => {
  it('returns defaults when nothing is stored', async () => {
    const { db, service } = openService()
    try {
      assert.deepEqual(await service.getSettings(), CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })

  it('returns valid stored settings', async () => {
    const { db, service } = openService()
    try {
      await service.updateSettings({ appearance: 'system', confirmBeforeDestructiveActions: false })
      assert.deepEqual(await service.getSettings(), {
        appearance: 'system',
        reduceMotion: false,
        confirmBeforeDestructiveActions: false
      })
    } finally {
      db.close()
    }
  })

  it('partial update changes the requested field only', async () => {
    const { db, service } = openService()
    try {
      const updated = await service.updateSettings({ reduceMotion: true })
      assert.equal(updated.reduceMotion, true)
      assert.equal(updated.appearance, 'dark')
      assert.equal(updated.confirmBeforeDestructiveActions, true)
    } finally {
      db.close()
    }
  })

  it('multiple valid fields update together', async () => {
    const { db, service } = openService()
    try {
      const updated = await service.updateSettings({ appearance: 'system', reduceMotion: true })
      assert.deepEqual(updated, {
        appearance: 'system',
        reduceMotion: true,
        confirmBeforeDestructiveActions: true
      })
    } finally {
      db.close()
    }
  })

  it('appearance accepts dark and system', async () => {
    const { db, service } = openService()
    try {
      assert.equal((await service.updateSettings({ appearance: 'dark' })).appearance, 'dark')
      assert.equal((await service.updateSettings({ appearance: 'system' })).appearance, 'system')
    } finally {
      db.close()
    }
  })

  it('appearance rejects invalid strings without persisting', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.updateSettings({ appearance: 'blue' }), InvalidSettingsError)
      assert.deepEqual(await service.getSettings(), CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })

  it('boolean fields reject non-booleans', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.updateSettings({ reduceMotion: 'yes' }), InvalidSettingsError)
      await assert.rejects(
        service.updateSettings({ confirmBeforeDestructiveActions: 1 }),
        InvalidSettingsError
      )
      await assert.rejects(service.updateSettings({ reduceMotion: null }), InvalidSettingsError)
      assert.deepEqual(await service.getSettings(), CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })

  it('unknown update keys are rejected at runtime', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.updateSettings({ unknownSetting: true }), InvalidSettingsError)
      await assert.rejects(
        service.updateSettings({ reduceMotion: true, unknownSetting: true }),
        InvalidSettingsError
      )
      assert.deepEqual(await service.getSettings(), CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })

  it('non-object update payloads are rejected', async () => {
    const { db, service } = openService()
    try {
      await assert.rejects(service.updateSettings(null), InvalidSettingsError)
      await assert.rejects(service.updateSettings('dark'), InvalidSettingsError)
      await assert.rejects(service.updateSettings([{ reduceMotion: true }]), InvalidSettingsError)
    } finally {
      db.close()
    }
  })

  it('reset returns defaults and persists deterministic state', async () => {
    const { db, service } = openService()
    try {
      await service.updateSettings({ appearance: 'system', reduceMotion: true })
      const reset = await service.resetSettings()
      assert.deepEqual(reset, CANONICAL_DEFAULTS)
      assert.deepEqual(await service.getSettings(), CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })

  it('stored partial data merges with current defaults', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const repository = new KeyValueRepository(db)
      repository.set(SETTINGS_STORAGE_KEY, { reduceMotion: true, futureField: 1 })
      const service = new SettingsService(repository)
      assert.deepEqual(await service.getSettings(), {
        appearance: 'dark',
        reduceMotion: true,
        confirmBeforeDestructiveActions: true
      })
    } finally {
      db.close()
    }
  })

  it('corrupt stored settings cause a controlled error', async () => {
    const invalidJson = new DatabaseSync(':memory:')
    try {
      runMigrations(invalidJson, migrations)
      invalidJson.exec(`INSERT INTO key_value (key, value, updated_at) VALUES ('${SETTINGS_STORAGE_KEY}', '{broken', 0)`)
      const service = new SettingsService(new KeyValueRepository(invalidJson))
      await assert.rejects(service.getSettings(), CorruptSettingsError)
    } finally {
      invalidJson.close()
    }
    const wrongShape = new DatabaseSync(':memory:')
    try {
      runMigrations(wrongShape, migrations)
      const repository = new KeyValueRepository(wrongShape)
      repository.set(SETTINGS_STORAGE_KEY, { appearance: 'blue' })
      const service = new SettingsService(repository)
      await assert.rejects(service.getSettings(), CorruptSettingsError)
    } finally {
      wrongShape.close()
    }
  })

  it('persistence survives database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-settings-test-'))
    try {
      const file = join(dir, 'settings.db')
      const first = new DatabaseSync(file)
      try {
        runMigrations(first, migrations)
        const service = new SettingsService(new KeyValueRepository(first))
        await service.updateSettings({ appearance: 'system' })
      } finally {
        first.close()
      }
      const second = new DatabaseSync(file)
      try {
        runMigrations(second, migrations)
        const service = new SettingsService(new KeyValueRepository(second))
        assert.equal((await service.getSettings()).appearance, 'system')
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('operations cannot mutate the canonical defaults', async () => {
    const { db, service } = openService()
    try {
      assert.ok(Object.isFrozen(DEFAULT_SETTINGS))
      await service.updateSettings({ appearance: 'system', reduceMotion: true })
      await service.resetSettings()
      assert.deepEqual(DEFAULT_SETTINGS, CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })

  it('returned settings cannot mutate canonical defaults', async () => {
    const { db, service } = openService()
    try {
      const first = await service.getSettings()
      assert.notStrictEqual(first, DEFAULT_SETTINGS)
      const mutable = first as unknown as Record<string, unknown>
      mutable['appearance'] = 'system'
      mutable['reduceMotion'] = true
      assert.deepEqual(await service.getSettings(), CANONICAL_DEFAULTS)
      assert.deepEqual(DEFAULT_SETTINGS, CANONICAL_DEFAULTS)
    } finally {
      db.close()
    }
  })
})
