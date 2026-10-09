import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyStartupError,
  FATAL_START_GUIDANCE,
  FATAL_START_MESSAGE,
  NEWER_SCHEMA_MESSAGE,
  toSafeFatalCopy
} from './startup-failure'
import { STARTUP_ORDER, SHUTDOWN_ORDER } from './startup-limits'

describe('startup failure classification', () => {
  it('declares the explicit startup dependency order', () => {
    assert.deepEqual([...STARTUP_ORDER], [
      'single-instance-lock',
      'protocol-handlers',
      'paths',
      'sqlite-open-migrate',
      'core-services',
      'startup-recovery',
      'secured-window',
      'usable',
      'cloud-restore-detached'
    ])
    assert.deepEqual([...SHUTDOWN_ORDER], [
      'stop-accepting-work',
      'close-preview-surfaces',
      'stop-runtime-trees',
      'terminate-terminals',
      'flush-runtime-state',
      'close-database',
      'exit'
    ])
  })

  it('classifies database/migration/schema failures as fatal-local', () => {
    assert.equal(classifyStartupError(new Error('migration 7 (x) failed')), 'fatal-local')
    assert.equal(classifyStartupError(new Error('unable to open database file')), 'fatal-local')
    assert.equal(classifyStartupError(new Error('newer version of STARK (data v19')), 'fatal-local')
    assert.equal(classifyStartupError(new Error('WAL journal mode could not be enabled')), 'fatal-local')
    assert.equal(classifyStartupError(new Error('preload bundle impossible to load')), 'fatal-local')
  })

  it('classifies optional subsystems as recoverable-optional', () => {
    assert.equal(classifyStartupError(new Error('cloud-auth-unavailable')), 'recoverable-optional')
    assert.equal(classifyStartupError(new Error('auth restore unavailable')), 'recoverable-optional')
    assert.equal(classifyStartupError(new Error('usage cleanup failure')), 'recoverable-optional')
    assert.equal(classifyStartupError(new Error('provider discovery failure')), 'recoverable-optional')
  })

  it('produces safe fatal copy with no paths, SQL, or stacks', () => {
    const copy = toSafeFatalCopy(new Error("unable to open 'C:\\Users\\x\\stark.db': SQLITE_CANTOPEN"))
    assert.equal(copy.category, 'local-data')
    assert.equal(copy.guidance, FATAL_START_GUIDANCE)
    const serialized = JSON.stringify({ message: FATAL_START_MESSAGE, ...copy })
    assert.ok(!serialized.includes('C:\\Users'))
    assert.ok(!serialized.includes('SQLITE'))
    assert.ok(!serialized.includes('stark.db'))
    assert.equal(NEWER_SCHEMA_MESSAGE, 'This STARK data was created by a newer version of STARK.')
  })
})
