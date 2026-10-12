import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STARK_AUTH_REDIRECT_URI } from '../cloud-account/cloud-account-limits'

/**
 * Development-only local env loading (Stage: account QA).
 *
 * Normal local development does not populate process.env, so the real
 * Supabase Auth configuration would never reach CloudAccountService
 * and Account would stay "not configured". In development only, this
 * module loads a small allowlist of public auth keys from the
 * uncommitted `<appPath>/.env.local` into the Electron MAIN process
 * env BEFORE services are constructed.
 *
 * Safety:
 * - Packaged builds never touch `.env.local`.
 * - Only allowlisted keys are accepted; everything else is ignored.
 * - Explicitly exported variables always win (never overridden).
 * - Missing/unreadable files are a silent no-op (config stays missing).
 * - Nothing here reaches the renderer or preload: main process only,
 *   and only the two public Supabase values plus the fixed redirect.
 * - Values are never logged (diagnostics report booleans only).
 */

/** Env keys this loader may set (public auth config only). */
export const DEV_ENV_ALLOWED_KEYS: readonly string[] = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'STARK_AUTH_REDIRECT_URL'
]

/** Largest `.env.local` accepted (64 KiB — config, not content). */
export const MAX_DEV_ENV_FILE_BYTES = 64 * 1024

/** Name of the uncommitted local env file at the project root. */
export const DEV_ENV_FILE_NAME = '.env.local'

/**
 * Parses dotenv-style text into allowlisted key/value pairs (pure).
 * Supports `KEY=value`, `export KEY=value`, single/double quotes,
 * `#` comments, and blank lines. Anything outside the allowlist is
 * dropped; malformed lines are skipped. Never throws.
 */
export function parseDevEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof text !== 'string' || text === '') {
    return out
  }
  const allowed = new Set<string>(DEV_ENV_ALLOWED_KEYS)
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line
    const separator = withoutExport.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = withoutExport.slice(0, separator).trim()
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(out, key)) {
      continue
    }
    let value = withoutExport.slice(separator + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      value = (hash === -1 ? value : value.slice(0, hash)).trim()
    }
    if (value === '' || value.includes('\0') || value.includes('\n')) {
      continue
    }
    // The OAuth redirect is fixed in code: only the exact documented
    // value is honored; anything else is ignored (no override surface).
    if (key === 'STARK_AUTH_REDIRECT_URL' && value !== STARK_AUTH_REDIRECT_URI) {
      continue
    }
    out[key] = value
  }
  return out
}

export interface DevEnvLoadResult {
  /** True when the file was read (even if it contributed no keys). */
  readonly loaded: boolean
  /** Allowlisted keys actually applied to env (names only, never values). */
  readonly appliedKeys: readonly string[]
}

/**
 * Loads `.env.local` into the given env mapping for development.
 * Skipped entirely when packaged. Never overrides keys the process
 * environment already defines. Never throws — failures leave env
 * untouched (auth reports missing config as before).
 */
export function loadDevEnvFile(input: {
  readonly appPath: string
  readonly isPackaged: boolean
  readonly env: NodeJS.ProcessEnv
}): DevEnvLoadResult {
  const empty: DevEnvLoadResult = { loaded: false, appliedKeys: [] }
  if (input.isPackaged || typeof input.appPath !== 'string' || input.appPath === '') {
    return empty
  }
  let text: string
  try {
    const filePath = join(input.appPath, DEV_ENV_FILE_NAME)
    if (statSync(filePath).size > MAX_DEV_ENV_FILE_BYTES) {
      return empty
    }
    text = readFileSync(filePath, 'utf8')
  } catch {
    return empty
  }
  const parsed = parseDevEnvFile(text)
  const applied: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    const current = input.env[key]
    if (typeof current === 'string' && current !== '') {
      continue
    }
    input.env[key] = value
    applied.push(key)
  }
  return { loaded: true, appliedKeys: applied }
}
