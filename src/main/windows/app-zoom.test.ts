import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  APP_ZOOM_MAX_FACTOR,
  APP_ZOOM_MIN_FACTOR,
  APP_ZOOM_RESET_FACTOR,
  APP_ZOOM_STEP,
  nextZoomFactor,
  normalizeZoomShortcut,
  type AppZoomKeyInput
} from './app-zoom'

/**
 * Hackathon QA Bug #1: Ctrl+- zoomed out but Ctrl++ never zoomed back
 * in (on Windows "+" is Shift + "="), with no reliable reset. Zoom is
 * now main-owned: these tests pin the key normalization and the
 * bounded factor math directly, plus the security/isolation shape.
 */
function keyDown(overrides: Partial<AppZoomKeyInput>): AppZoomKeyInput {
  return {
    type: 'keyDown',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    key: '',
    code: '',
    ...overrides
  }
}

describe('zoom shortcut normalization', () => {
  it('Ctrl+- zooms out (main key and numpad)', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '-', code: 'Minus' })), 'out')
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: 'Subtract', code: 'NumpadSubtract' })), 'out')
    // Code-only match still resolves (layout variance).
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '', code: 'Minus' })), 'out')
  })

  it('Ctrl+= zooms in without Shift', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '=', code: 'Equal' })), 'in')
  })

  it('Ctrl+Shift+= zooms in (the Windows "+" path)', () => {
    assert.equal(
      normalizeZoomShortcut(keyDown({ control: true, shift: true, key: '+', code: 'Equal' })),
      'in'
    )
  })

  it('literal Ctrl++ zooms in where represented', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '+', code: 'Equal' })), 'in')
  })

  it('Ctrl+NumpadAdd zooms in', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: 'Add', code: 'NumpadAdd' })), 'in')
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '', code: 'NumpadAdd' })), 'in')
  })

  it('Ctrl+0 resets (main row and numpad)', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '0', code: 'Digit0' })), 'reset')
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, key: '', code: 'Numpad0' })), 'reset')
  })

  it('Cmd variants behave identically (macOS parity, no extra code)', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ meta: true, key: '-', code: 'Minus' })), 'out')
    assert.equal(normalizeZoomShortcut(keyDown({ meta: true, shift: true, key: '+', code: 'Equal' })), 'in')
    assert.equal(normalizeZoomShortcut(keyDown({ meta: true, key: '0', code: 'Digit0' })), 'reset')
  })

  it('plain typing is never intercepted', () => {
    for (const [key, code] of [['+', 'Equal'], ['=', 'Equal'], ['-', 'Minus'], ['0', 'Digit0']] as const) {
      assert.equal(normalizeZoomShortcut(keyDown({ key, code })), null, `typing ${key} must pass through`)
    }
  })

  it('other Ctrl chords are untouched (Ctrl+S/F/P, Monaco, terminal, composer)', () => {
    for (const [key, code] of [['s', 'KeyS'], ['f', 'KeyF'], ['p', 'KeyP'], ['a', 'KeyA'], ['c', 'KeyC']] as const) {
      assert.equal(
        normalizeZoomShortcut(keyDown({ control: true, key, code })),
        null,
        `Ctrl+${key} must pass through`
      )
    }
  })

  it('Alt-modified and non-keyDown events never trigger zoom', () => {
    assert.equal(normalizeZoomShortcut(keyDown({ control: true, alt: true, key: '-', code: 'Minus' })), null)
    assert.equal(
      normalizeZoomShortcut({ ...keyDown({ control: true, key: '+', code: 'Equal' }), type: 'keyUp' }),
      null
    )
    assert.equal(normalizeZoomShortcut(keyDown({ key: '0', code: 'Digit0' })), null)
  })
})

describe('zoom factor bounds', () => {
  it('steps are fixed and never drift', () => {
    assert.equal(APP_ZOOM_STEP, 0.1)
    let factor = APP_ZOOM_RESET_FACTOR
    for (let step = 0; step < 3; step += 1) {
      factor = nextZoomFactor(factor, 'in')
    }
    assert.equal(factor, 1.3)
  })

  it('zoom respects min/max clamps', () => {
    assert.equal(APP_ZOOM_MIN_FACTOR, 0.5)
    assert.equal(APP_ZOOM_MAX_FACTOR, 2.0)
    assert.equal(nextZoomFactor(APP_ZOOM_MIN_FACTOR, 'out'), APP_ZOOM_MIN_FACTOR)
    assert.equal(nextZoomFactor(APP_ZOOM_MAX_FACTOR, 'in'), APP_ZOOM_MAX_FACTOR)
    assert.equal(nextZoomFactor(0.1, 'out'), APP_ZOOM_MIN_FACTOR)
    assert.equal(nextZoomFactor(9, 'in'), APP_ZOOM_MAX_FACTOR)
  })

  it('reset always returns exactly 100%, even from the bounds', () => {
    assert.equal(nextZoomFactor(APP_ZOOM_MIN_FACTOR, 'reset'), 1)
    assert.equal(nextZoomFactor(APP_ZOOM_MAX_FACTOR, 'reset'), 1)
    assert.equal(nextZoomFactor(1.7, 'reset'), 1)
  })

  it('non-finite input fails closed to the reset factor path', () => {
    assert.equal(nextZoomFactor(Number.NaN, 'in'), 1.1)
  })
})

describe('zoom ownership and isolation', () => {
  function readSource(...parts: string[]): string {
    const file = join(process.cwd(), ...parts)
    assert.ok(existsSync(file), `${parts.join('/')} must exist`)
    return readFileSync(file, 'utf8')
  }

  it('zoom is main-owned with no generic IPC and no preload change', () => {
    const zoom = readSource('src', 'main', 'windows', 'app-zoom.ts')
    assert.ok(!zoom.includes('ipcMain'), 'zoom must not add IPC handlers')
    assert.ok(!zoom.includes('exposeInMainWorld'), 'zoom must not touch the preload bridge')
    assert.ok(zoom.includes('before-input-event'), 'zoom must intercept before Chromium/Monaco see the chord')
    assert.ok(zoom.includes('preventDefault'), 'recognized chords must suppress native double-handling')
    assert.ok(zoom.includes('isDestroyed'), 'destroyed windows must never be touched')
    const preload = readSource('src', 'preload', 'index.ts')
    assert.ok(!preload.toLowerCase().includes('zoom'), 'preload must gain no zoom surface')
  })

  it('app window wires zoom without changing the security posture', () => {
    const appWindow = readSource('src', 'main', 'windows', 'app-window.ts')
    assert.ok(appWindow.includes('configureAppZoom(window)'), 'main window must own zoom')
    assert.ok(appWindow.includes('contextIsolation: true'), 'hardened options must stay intact')
  })
})
