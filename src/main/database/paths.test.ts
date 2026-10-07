import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEV_DATABASE_FILE, PROD_DATABASE_FILE, resolveDatabaseFile } from './paths'

describe('database paths', () => {
  it('development uses the isolated dev filename', () => {
    const dir = join('some', 'dir')
    assert.equal(resolveDatabaseFile(false, dir), join(dir, 'stark-dev.db'))
    assert.equal(DEV_DATABASE_FILE, 'stark-dev.db')
  })

  it('packaged production uses the production filename', () => {
    const dir = join('some', 'dir')
    assert.equal(resolveDatabaseFile(true, dir), join(dir, 'stark.db'))
    assert.equal(PROD_DATABASE_FILE, 'stark.db')
  })
})
