import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installGlobalErrorHandlers, type GlobalErrorEmitter } from './global-errors'

function fakeEmitter(): { emitter: GlobalErrorEmitter; listeners: Map<string, ((error: unknown) => void)[]> } {
  const listeners = new Map<string, ((error: unknown) => void)[]>()
  return {
    listeners,
    emitter: {
      on: (event, listener) => {
        const existing = listeners.get(event) ?? []
        existing.push(listener)
        listeners.set(event, existing)
      },
      removeListener: (event, listener) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    }
  }
}

describe('global error handling', () => {
  it('logs one redacted line and quits once on uncaughtException', () => {
    const { emitter, listeners } = fakeEmitter()
    const logs: string[] = []
    let quits = 0
    const uninstall = installGlobalErrorHandlers(emitter, {
      logFatal: (category, detail) => {
        logs.push(`${category}:${detail}`)
      },
      quitAfterFatal: () => {
        quits += 1
      }
    })
    const handlers = listeners.get('uncaughtException') ?? []
    assert.equal(handlers.length, 1)
    handlers[0](new Error('boom sk-SECRETKEY12345678 with code=ABC123'))
    handlers[0](new Error('second fatal'))
    assert.equal(quits, 1)
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('uncaught-exception'))
    assert.ok(!logs[0].includes('sk-SECRETKEY12345678'))
    assert.ok(!logs[0].includes('code=ABC123'))
    uninstall()
    assert.equal((listeners.get('uncaughtException') ?? []).length, 0)
  })

  it('logs unhandled rejections without quitting', () => {
    const { emitter, listeners } = fakeEmitter()
    const logs: string[] = []
    let quits = 0
    const uninstall = installGlobalErrorHandlers(emitter, {
      logFatal: (category, detail) => {
        logs.push(`${category}:${detail}`)
      },
      quitAfterFatal: () => {
        quits += 1
      }
    })
    const handlers = listeners.get('unhandledRejection') ?? []
    assert.equal(handlers.length, 1)
    handlers[0]('string rejection Bearer TOKEN123456')
    assert.equal(quits, 0)
    assert.equal(logs.length, 1)
    assert.ok(!logs[0].includes('TOKEN123456'))
    uninstall()
  })
})
