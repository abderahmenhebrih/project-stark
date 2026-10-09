import { BrowserWindow } from 'electron'
import { APP_NAME } from '../../shared/constants'
import { buildPreviewWindowOptions, type PreviewWindow } from './runtime-preview'

/**
 * Production Live Preview window factory (main process only).
 *
 * The window is deliberately bridge-less: no preload, no
 * `window.stark`, no Node integration — only the hardened options
 * from `buildPreviewWindowOptions` plus main-frame/window-open wiring
 * applied by the runtime service. Never called from tests.
 */
export function createPreviewBrowserWindow(runtime: { id: number; port: number; url: string }): PreviewWindow {
  void runtime.port
  const window = new BrowserWindow({
    ...buildPreviewWindowOptions(runtime.id),
    title: `${APP_NAME} Live Preview`
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.warn(`[${APP_NAME}] preview renderer gone: ${details.reason}`)
  })
  return window as unknown as PreviewWindow
}
