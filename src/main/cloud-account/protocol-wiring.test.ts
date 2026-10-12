import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Auth deep-link wiring proof (main/index.ts structure): the OS
 * callback must reach the RUNNING instance on every platform —
 * Windows/Linux first- and second-instance argv, macOS open-url —
 * through the single-instance lock, with the window brought forward.
 * No localhost server, no extra ports.
 */
function readIndex(): string {
  return readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
}

describe('auth deep-link wiring', () => {
  it('registers the protocol through the audited builder, never bare', () => {
    const source = readIndex()
    assert.ok(source.includes('buildAuthProtocolRegistration'), 'registration must go through the builder')
    assert.ok(source.includes('registerAuthProtocolClient'), 'registration must go through the safe wrapper')
    assert.ok(!source.includes('setAsDefaultProtocolClient('), 'no bare protocol registration may remain')
  })

  it('establishes the single-instance lock before callback handling', () => {
    const source = readIndex()
    const lockAt = source.indexOf('requestSingleInstanceLock')
    const secondAt = source.indexOf("app.on('second-instance'")
    assert.ok(lockAt >= 0 && secondAt > lockAt, 'lock must precede the second-instance handler')
  })

  it('forwards second-instance callbacks and focuses the window', () => {
    const source = readIndex()
    assert.ok(source.includes('extractDeepLinkFromArgv(argv)'), 'second instance must scan argv for the link')
    assert.ok(source.includes('handleAuthDeepLink(deepLink)'), 'second instance must forward the link')
    assert.ok(source.includes('mainWindow.focus()'), 'a callback must bring the window forward')
  })

  it('handles macOS open-url and cold-start argv after services exist', () => {
    const source = readIndex()
    assert.ok(source.includes("app.on('open-url'"), 'macOS open-url must be handled')
    assert.ok(source.includes('handleAuthDeepLink(url)'), 'open-url must reach the same handler')
    assert.ok(source.includes('extractDeepLinkFromArgv(process.argv)'), 'cold-start argv must be scanned')
  })

  it('focuses the window on every handled callback', () => {
    const source = readIndex()
    const handlerAt = source.indexOf('function handleAuthDeepLink')
    assert.ok(handlerAt >= 0, 'handler must exist')
    const body = source.slice(handlerAt, source.indexOf('\n}\n', handlerAt))
    assert.ok(body.includes('focusMainWindowBestEffort'), 'handled callbacks must focus the window')
    // Only the safe outcome category may log: no log line may carry
    // the raw URL, code, or tokens.
    for (const line of body.split('\n')) {
      if (line.includes('console.log(')) {
        assert.ok(!line.includes('rawUrl'), 'callback logging must never include the URL')
      }
    }
    assert.ok(body.includes("'[STARK] account callback rejected'"), 'rejections log a category only')
  })
})
