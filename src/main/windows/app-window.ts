import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '../../shared/constants'
import { RENDERER_DEV_URL, RENDERER_ENTRY, RENDERER_DIR, devServerOrigin } from '../security/app-urls'
import { isAllowedExternalUrl, isAllowedMainFrameNavigation } from '../security/external-url'
import { configureMicrophonePermissions } from './voice-permissions'

function logRendererLoadError(error: unknown): void {
  console.error(`[${APP_NAME}] failed to load renderer:`, error)
}

/**
 * Hardened main-window options (Stage 30 release matrix).
 * contextIsolation on, nodeIntegration off, sandboxed, STARK preload
 * only. Pure so the release security suite asserts the exact posture
 * without constructing a BrowserWindow.
 */
export function buildMainWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0c0a',
    title: APP_NAME,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

/**
 * Creates the single STARK application window.
 *
 * Security posture:
 * - contextIsolation enabled, nodeIntegration disabled, sandbox enabled.
 * - The renderer receives no Node.js access; it talks to the main
 *   process only through the preload bridge.
 * - Only http(s) links reach the OS browser; everything else is denied.
 * - The main frame cannot navigate away from the application.
 */
export function createAppWindow(): BrowserWindow {
  const window = new BrowserWindow(buildMainWindowOptions())

  // Step 4: audio-only microphone permission (explicit user click
  // only, never background listening). Camera and every other
  // permission fail closed.
  configureMicrophonePermissions(window)

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url)
    } else {
      console.warn(`[${APP_NAME}] blocked new-window request to a disallowed URL`)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isAllowedMainFrameNavigation(url, {
      devServerOrigin: devServerOrigin(),
      rendererDirectory: RENDERER_DIR
    })
    if (!allowed) {
      console.warn(`[${APP_NAME}] blocked main-frame navigation away from the application`)
      event.preventDefault()
    }
  })

  if (RENDERER_DEV_URL !== undefined && RENDERER_DEV_URL !== '') {
    window.loadURL(RENDERER_DEV_URL).catch(logRendererLoadError)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    window.loadFile(RENDERER_ENTRY).catch(logRendererLoadError)
  }

  return window
}
