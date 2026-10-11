import type { BrowserWindow } from 'electron'

/**
 * Application zoom shortcuts (hackathon QA Bug #1).
 *
 * STARK owns zoom explicitly in the main process through
 * `before-input-event`: no renderer code, no IPC channel, no preload
 * change. Only the exact Ctrl/Cmd zoom chords are intercepted — every
 * other key (typing, Monaco, terminal, composer, Ctrl+S/F/P/…) passes
 * through untouched.
 *
 * Windows-first: on a standard Windows keyboard "+" is Shift + "=",
 * so zoom-in must accept Ctrl+=, Ctrl+Shift+=, and a literal Ctrl++
 * alike (matched on both `key` and `code`).
 */

/** Minimum zoom factor (50%). */
export const APP_ZOOM_MIN_FACTOR = 0.5

/** Maximum zoom factor (200%). */
export const APP_ZOOM_MAX_FACTOR = 2.0

/** Fixed zoom step per press (10 percentage points). */
export const APP_ZOOM_STEP = 0.1

/** Reset target: exactly 100%. */
export const APP_ZOOM_RESET_FACTOR = 1

export type AppZoomAction = 'in' | 'out' | 'reset'

/**
 * Structural subset of Electron's `Input` needed for zoom matching.
 * Taken from `before-input-event` — never from the renderer.
 */
export interface AppZoomKeyInput {
  readonly type: string
  readonly control: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift?: boolean
  readonly key: string
  readonly code: string
}

function isZoomInKey(key: string, code: string): boolean {
  return key === '+' || key === '=' || key === 'Add' || code === 'Equal' || code === 'NumpadAdd'
}

function isZoomOutKey(key: string, code: string): boolean {
  return key === '-' || key === 'Subtract' || code === 'Minus' || code === 'NumpadSubtract'
}

function isZoomResetKey(key: string, code: string): boolean {
  return key === '0' || code === 'Digit0' || code === 'Numpad0'
}

/**
 * Maps one raw key event to a zoom action, or null when the event is
 * not a STARK zoom chord. Pure and unit-testable: Ctrl (Windows/Linux)
 * or Cmd (macOS) without Alt; Shift is allowed (required for "+").
 * Plain typing ("+", "=", "-", "0") and every other Ctrl chord
 * (notably Ctrl+S/F/P) return null so nothing else is intercepted.
 */
export function normalizeZoomShortcut(input: AppZoomKeyInput): AppZoomAction | null {
  if (input.type !== 'keyDown') {
    return null
  }
  if (!(input.control || input.meta) || input.alt) {
    return null
  }
  const { key, code } = input
  if (isZoomInKey(key, code)) {
    return 'in'
  }
  if (isZoomOutKey(key, code)) {
    return 'out'
  }
  if (isZoomResetKey(key, code)) {
    return 'reset'
  }
  return null
}

/**
 * Next zoom factor for one action: fixed steps, clamped to
 * [50%, 200%], rounded to one decimal so repeated presses never drift
 * (3 steps in from 100% lands on exactly 130%). Reset always returns
 * exactly 100%, even from the bounds.
 */
export function nextZoomFactor(current: number, action: AppZoomAction): number {
  if (action === 'reset') {
    return APP_ZOOM_RESET_FACTOR
  }
  const base = Number.isFinite(current) ? current : APP_ZOOM_RESET_FACTOR
  const stepped = action === 'in' ? base + APP_ZOOM_STEP : base - APP_ZOOM_STEP
  const clamped = Math.min(APP_ZOOM_MAX_FACTOR, Math.max(APP_ZOOM_MIN_FACTOR, stepped))
  return Math.round(clamped * 10) / 10
}

/**
 * Owns zoom for one application window: intercepts exactly the STARK
 * zoom chords before Chromium/Monaco see them and applies the bounded
 * factor directly on the owning webContents. No IPC, no preload, no
 * renderer involvement.
 */
export function configureAppZoom(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    const action = normalizeZoomShortcut({
      type: input.type,
      control: input.control,
      meta: input.meta,
      alt: input.alt,
      shift: input.shift,
      key: input.key,
      code: input.code
    })
    if (action === null) {
      return
    }
    event.preventDefault()
    const contents = window.webContents
    if (contents.isDestroyed()) {
      return
    }
    contents.setZoomFactor(nextZoomFactor(contents.getZoomFactor(), action))
  })
}
