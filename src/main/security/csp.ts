/**
 * Content-Security-Policy construction.
 *
 * Pure module: no Electron imports, so the policy logic stays testable
 * outside the Electron runtime. Wiring lives in ./session.ts.
 *
 * Production serves only packaged files, so the policy trusts 'self'
 * (plus data: images/fonts and the inline <style> block in index.html).
 * Development additionally trusts the Vite dev-server origin for
 * scripts, HMR websockets, and styles — nothing broader.
 */

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
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
        `img-src 'self' data: ${origin}`,
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
