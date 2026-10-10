import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkExtensionUpdate, compareExtensionVersions, planExtensionUpdate } from './extension-updates'

describe('extension updates', () => {
  it('compares versions deterministically', () => {
    assert.ok(compareExtensionVersions('1.0.0', '1.0.1') < 0)
    assert.ok(compareExtensionVersions('2.0.0', '1.9.9') > 0)
    assert.equal(compareExtensionVersions('1.0.0', '1.0.0'), 0)
  })

  it('plans manual updates without downgrades', () => {
    assert.deepEqual(planExtensionUpdate('1.0.0', '1.0.1'), { updateAvailable: true, latestVersion: '1.0.1' })
    assert.deepEqual(planExtensionUpdate('1.0.1', '1.0.1'), { updateAvailable: false, latestVersion: '1.0.1' })
    assert.deepEqual(planExtensionUpdate('2.0.0', '1.0.0'), { updateAvailable: false, latestVersion: '1.0.0' })
    assert.deepEqual(planExtensionUpdate('1.0.0', null), { updateAvailable: false, latestVersion: null })
  })

  it('treats catalog failures as no-update (offline-safe)', async () => {
    const failing = { latestVersion: async (): Promise<string | null> => { throw new Error('offline') } }
    assert.deepEqual(await checkExtensionUpdate(failing, { namespace: 'a', name: 'b', version: '1.0.0' }), {
      updateAvailable: false,
      latestVersion: null
    })
    const newer = { latestVersion: async (): Promise<string | null> => '1.0.1' }
    assert.deepEqual(await checkExtensionUpdate(newer, { namespace: 'a', name: 'b', version: '1.0.0' }), {
      updateAvailable: true,
      latestVersion: '1.0.1'
    })
  })
})
