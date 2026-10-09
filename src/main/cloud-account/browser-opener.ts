import { shell } from 'electron'

/**
 * Production system-browser opener (Stage 29).
 *
 * Opens exactly one URL per OAuth attempt in the OS default browser.
 * Never inside a STARK BrowserWindow, Preview window, WebView, or
 * renderer iframe. Injected as a seam so tests use fakes without
 * touching Electron.
 */
export async function openSystemBrowserOnce(url: string): Promise<void> {
  await shell.openExternal(url)
}
