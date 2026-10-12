import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildAuthProtocolRegistration,
  registerAuthProtocolClient
} from './protocol-registration'

const APP_DIR = join(tmpdir(), 'stark-auth-app')
const ENTRY = join(APP_DIR, 'entry.js')

describe('auth protocol registration', () => {
  it('registers the packaged binary plainly', () => {
    assert.deepEqual(
      buildAuthProtocolRegistration({
        isPackaged: true,
        defaultApp: false,
        execPath: join(APP_DIR, 'stark'),
        argv1: undefined,
        appPath: APP_DIR
      }),
      { protocol: 'stark', execPath: null, args: null }
    )
  })

  it('uses the documented executable-plus-entry recipe for dev launches', () => {
    const registration = buildAuthProtocolRegistration({
      isPackaged: false,
      defaultApp: true,
      execPath: join(tmpdir(), 'electron'),
      argv1: ENTRY,
      appPath: APP_DIR
    })
    assert.equal(registration.protocol, 'stark')
    assert.equal(registration.execPath, join(tmpdir(), 'electron'))
    assert.deepEqual(registration.args, [ENTRY])
  })

  it('falls back to the absolute app directory when no usable entry exists', () => {
    for (const argv1 of [undefined, '', '--remote-debugging-port=9222', 'relative/entry.js']) {
      const registration = buildAuthProtocolRegistration({
        isPackaged: false,
        defaultApp: true,
        execPath: join(tmpdir(), 'electron'),
        argv1,
        appPath: APP_DIR
      })
      // Never a relative path: the OS launch cwd is not ours.
      assert.deepEqual(registration.args, [APP_DIR])
    }
  })

  it('applies the registration and never throws', () => {
    const calls: { protocol: string; execPath?: string; args?: readonly string[] }[] = []
    const ok = registerAuthProtocolClient(
      {
        setAsDefaultProtocolClient: (protocol: string, execPath?: string, args?: readonly string[]) => {
          calls.push({ protocol, execPath, args })
          return true
        }
      },
      { protocol: 'stark', execPath: '/sdk/electron', args: ['/proj/app'] }
    )
    assert.equal(ok, true)
    assert.deepEqual([...calls], [{ protocol: 'stark', execPath: '/sdk/electron', args: ['/proj/app'] }])
    const plain = registerAuthProtocolClient(
      {
        setAsDefaultProtocolClient: (protocol: string) => {
          calls.push({ protocol })
          return true
        }
      },
      { protocol: 'stark', execPath: null, args: null }
    )
    assert.equal(plain, true)
    const failed = registerAuthProtocolClient(
      {
        setAsDefaultProtocolClient: () => {
          throw new Error('no bridge')
        }
      },
      { protocol: 'stark', execPath: null, args: null }
    )
    assert.equal(failed, false)
  })
})
