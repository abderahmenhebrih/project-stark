/**
 * Content-Security-Policy construction.
 *
 * Pure module: no Electron imports, so the policy logic stays testable
 * outside the Electron runtime. Wiring lives in ./session.ts.
 *
 * Production serves only packaged files, so the policy trusts 'self'
 * (plus data: images/fonts and the inline <style> block in index.html).
 * Extension-catalog artwork loads from the main-owned
 * stark-extension-icon: resource scheme (opaque IDs only, resolved
 * store-side after main validates the official Open VSX icon source
 * and retrieves the bounded image bytes itself) — the renderer never
 * fetches remote icon bytes, so no remote image origin is named here.
 * Chat-attachment thumbnails load from the main-owned
 * stark-attachment:// content scheme (opaque IDs only, resolved
 * store-side), so img-src names that scheme explicitly too.
 * Development additionally trusts the Vite dev-server origin for
 * scripts, HMR websockets, and styles — nothing broader. The dev
 * img-src carries the same icon scheme: without it every catalog
 * icon fails to load under `npm run dev` and the UI falls back to
 * the generic glyph for all entries.
 */

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: stark-attachment: stark-extension-icon:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/**
 * Builds the CSP for the current environment.
 * Falls back to the restrictive production policy whenever the
 * environment cannot be positively identified as development.
 */
export function buildCspPolicy(isPackaged: boolean, devServerUrl: string | undefined): string {
  if (!isPackaged && devServerUrl !== undefined && devServerUrl !== '') {
    try {
      const origin = new URL(devServerUrl).origin
      const wsOrigin = origin.replace(/^http/, 'ws')
      return [
        `default-src 'self' ${origin}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
        `style-src 'self' 'unsafe-inline' ${origin}`,
        `img-src 'self' data: stark-attachment: stark-extension-icon: ${origin}`,
        `font-src 'self' data: ${origin}`,
        `connect-src 'self' ${origin} ${wsOrigin}`,
        "object-src 'none'",
        "base-uri 'self'"
      ].join('; ')
    } catch {
      // Invalid dev URL — fall through to the production policy.
    }
  }
  return PROD_CSP
}
