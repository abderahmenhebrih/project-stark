import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FatalStartupPresenter } from './fatal-startup'
import { FATAL_START_GUIDANCE, FATAL_START_MESSAGE } from './startup-failure'

describe('fatal startup presentation', () => {
  it('shows exactly one safe dialog per failed startup, then quits', () => {
    const shown: unknown[] = []
    let quits = 0
    const presenter = new FatalStartupPresenter({
      showFatalSync: (options) => {
        shown.push(options)
      },
      quit: () => {
        quits += 1
      }
    })
    presenter.presentFatal('local-data')
    presenter.presentFatal('local-data')
    presenter.presentFatal('application-resources')
    assert.equal(shown.length, 1)
    assert.ok(quits >= 1)
    const first = shown[0] as Record<string, unknown>
    assert.equal(first['title'], FATAL_START_MESSAGE)
    assert.ok(String(first['message']).includes(FATAL_START_MESSAGE))
    assert.ok(String(first['message']).includes('local-data'))
    assert.equal(first['detail'], FATAL_START_GUIDANCE)
    const serialized = JSON.stringify(shown)
    assert.ok(!serialized.includes('Error:'))
    assert.ok(!serialized.includes('at '))
  })

  it('still quits when the dialog surface throws', () => {
    let quits = 0
    const presenter = new FatalStartupPresenter({
      showFatalSync: () => {
        throw new Error('dialog unavailable')
      },
      quit: () => {
        quits += 1
      }
    })
    presenter.presentFatal('application-resources')
    assert.equal(presenter.hasPresented, true)
    assert.equal(quits, 1)
  })
})
