import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { configureNativeApplicationMenu, shouldRemoveNativeApplicationMenu } from './app-menu'

describe('native application menu policy', () => {
  it('removes the menu on Windows and Linux, keeps macOS system behavior', () => {
    assert.equal(shouldRemoveNativeApplicationMenu('win32'), true)
    assert.equal(shouldRemoveNativeApplicationMenu('linux'), true)
    assert.equal(shouldRemoveNativeApplicationMenu('darwin'), false)
  })

  it('nulls the application menu exactly once off macOS', () => {
    for (const platform of ['win32', 'linux']) {
      let calls = 0
      configureNativeApplicationMenu({
        platform,
        setApplicationMenu: (menu) => {
          calls += 1
          assert.equal(menu, null)
        }
      })
      assert.equal(calls, 1)
    }
  })

  it('never touches the menu on macOS', () => {
    let calls = 0
    configureNativeApplicationMenu({
      platform: 'darwin',
      setApplicationMenu: () => {
        calls += 1
      }
    })
    assert.equal(calls, 0)
  })

  it('never throws when the bridge fails', () => {
    configureNativeApplicationMenu({
      platform: 'win32',
      setApplicationMenu: () => {
        throw new Error('no bridge')
      }
    })
  })
})
