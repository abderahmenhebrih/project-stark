import { app, session } from 'electron'
import { RENDERER_DEV_URL, RENDERER_DIR, devServerOrigin } from './app-urls'
import { buildCspPolicy } from './csp'
import { isAllowedMainFrameNavigation } from './external-url'

/**
 * Attaches the Content-Security-Policy response header to STARK document
 * loads only. Other pages (for example DevTools) are left untouched.
 * The policy itself is environment-specific (see ./csp.ts): restrictive
 * in production, narrowly relaxed for Vite/HMR in development.
 */
export function applyContentSecurityPolicy(): void {
  const policy = buildCspPolicy(app.isPackaged, RENDERER_DEV_URL)
  const origin = devServerOrigin()

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isAppDocument =
      details.resourceType === 'mainFrame' &&
      isAllowedMainFrameNavigation(details.url, {
        devServerOrigin: origin,
        rendererDirectory: RENDERER_DIR
      })
    if (!isAppDocument) {
      callback({})
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
