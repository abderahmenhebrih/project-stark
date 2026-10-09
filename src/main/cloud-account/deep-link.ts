import { CloudAuthCallbackInvalidError } from './cloud-account-errors'
import {
  MAX_AUTH_CALLBACK_PARAM_CHARS,
  MAX_AUTH_CALLBACK_URL_CHARS,
  STARK_AUTH_HOST,
  STARK_AUTH_PATH,
  STARK_AUTH_SCHEME
} from './cloud-account-limits'

/** Validated authorization-code extraction from a deep-link callback. */
export interface ParsedAuthCallback {
  readonly code: string
  readonly state: string | null
}

/**
 * Validates an application deep-link callback URL.
 *
 * Accepts EXACTLY stark://auth/callback with a bounded `code`
 * parameter (plus an optional bounded `state`). Rejects every other
 * scheme, host, path, credential-bearing authority, fragment payload,
 * unexpected parameter, missing code, or oversized value.
 */
export function parseAuthCallbackUrl(rawUrl: unknown): ParsedAuthCallback {
  if (typeof rawUrl !== 'string' || rawUrl === '' || rawUrl.length > MAX_AUTH_CALLBACK_URL_CHARS) {
    throw new CloudAuthCallbackInvalidError()
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new CloudAuthCallbackInvalidError()
  }
  if (parsed.protocol !== `${STARK_AUTH_SCHEME}:`) {
    throw new CloudAuthCallbackInvalidError()
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CloudAuthCallbackInvalidError()
  }
  if (parsed.hostname !== STARK_AUTH_HOST) {
    throw new CloudAuthCallbackInvalidError()
  }
  if (parsed.pathname !== STARK_AUTH_PATH) {
    throw new CloudAuthCallbackInvalidError()
  }
  if (parsed.hash !== '') {
    throw new CloudAuthCallbackInvalidError()
  }
  const params = parsed.searchParams
  const names = [...params.keys()]
  if (names.length === 0) {
    throw new CloudAuthCallbackInvalidError()
  }
  for (const name of names) {
    if (name !== 'code' && name !== 'state') {
      throw new CloudAuthCallbackInvalidError()
    }
  }
  const code = params.get('code')
  if (code === null || code === '' || code.length > MAX_AUTH_CALLBACK_PARAM_CHARS || code.includes('\0')) {
    throw new CloudAuthCallbackInvalidError()
  }
  const state = params.get('state')
  if (state !== null && (state.length > MAX_AUTH_CALLBACK_PARAM_CHARS || state.includes('\0'))) {
    throw new CloudAuthCallbackInvalidError()
  }
  return { code, state }
}

/**
 * Extracts the raw deep-link URL from Windows/Linux second-instance
 * argv (first stark:// argument) or returns null. Pure helper so the
 * platform wiring stays testable without Electron.
 */
export function extractDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${STARK_AUTH_SCHEME}://`)) {
      return arg.length <= MAX_AUTH_CALLBACK_URL_CHARS ? arg : null
    }
  }
  return null
}
