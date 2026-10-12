/**
 * Live Review localhost URL policy (pure, unit-testable).
 *
 * Human localhost reviewer only: loopback targets are allowed,
 * everything else is rejected with concise copy. No port scanning —
 * URLs come from the known managed-runtime URL or explicit user
 * input. No SSRF surface: remote domains, LAN IPs, and non-http(s)
 * schemes are refused.
 */

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1']

/** True when the value is an allowed loopback preview URL. */
export function isAllowedLiveReviewUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  // Normalize bracketed IPv6 (`new URL` strips brackets into hostname
  // on some runtimes, keeps them on others — accept both).
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host) && !(LOOPBACK_HOSTS as readonly string[]).includes(normalized)) {
    return false
  }
  if (parsed.port === '') {
    return false
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false
  }
  return true
}

/** Concise rejection copy for disallowed URLs (no stack traces). */
export function liveReviewUrlError(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    return 'Enter a localhost URL, e.g. http://localhost:3000.'
  }
  let protocol: string
  try {
    protocol = new URL(trimmed).protocol
  } catch {
    return 'That URL is invalid. Use http(s)://localhost:<port>.'
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return 'Only http and https localhost URLs are allowed.'
  }
  return 'Only localhost URLs are allowed (localhost, 127.0.0.1, ::1).'
}

/** Normalizes a user-entered URL (trims; adds http:// when schemeless localhost:port given). */
export function normalizeLiveReviewInput(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    return ''
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed
  }
  const bare = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/.exec(trimmed)
  if (bare !== null) {
    return `http://${trimmed}`
  }
  return trimmed
}
