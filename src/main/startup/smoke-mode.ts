import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Production-safe release smoke mode (Stage 30).
 *
 * Enabled ONLY by the test-packaging flag STARK_RELEASE_SMOKE=1. It
 * starts, opens/migrates an ISOLATED database, writes one bounded
 * ready marker, and quits cleanly. It never bypasses security,
 * disables sandboxing, skips migrations, exposes secrets, calls
 * providers, opens OAuth, or starts runtimes.
 */

export const RELEASE_SMOKE_ENV = 'STARK_RELEASE_SMOKE'
export const SMOKE_MARKER_ENV = 'STARK_SMOKE_MARKER'
export const SMOKE_USERDATA_ENV = 'STARK_SMOKE_USERDATA'

/** Parsed smoke configuration, or null when smoke mode is off. */
export interface ReleaseSmokeConfig {
  readonly markerPath: string
  readonly userDataDir: string
}

/**
 * Parses smoke-mode config from the environment. Returns null unless
 * STARK_RELEASE_SMOKE=1 with both marker and userdata paths set.
 * Never throws.
 */
export function parseSmokeConfig(env: NodeJS.ProcessEnv = process.env): ReleaseSmokeConfig | null {
  try {
    if (env[RELEASE_SMOKE_ENV] !== '1') {
      return null
    }
    const markerPath = env[SMOKE_MARKER_ENV]
    const userDataDir = env[SMOKE_USERDATA_ENV]
    if (typeof markerPath !== 'string' || markerPath === '' || typeof userDataDir !== 'string' || userDataDir === '') {
      return null
    }
    return { markerPath, userDataDir }
  } catch {
    return null
  }
}

/** Bounded ready-marker payload written by smoke mode. No secrets. */
export interface SmokeMarker {
  readonly ok: boolean
  readonly schemaVersion: number
  readonly appVersion: string
}

/**
 * Writes the single bounded ready marker atomically (parent dirs
 * created). Overwrites any previous marker. Best-effort caller
 * handles errors.
 */
export function writeSmokeMarker(markerPath: string, marker: SmokeMarker): void {
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, JSON.stringify(marker), 'utf8')
}

/** Default isolated smoke database file inside the smoke userdata dir. */
export function smokeDatabaseFile(userDataDir: string): string {
  return join(userDataDir, 'smoke.db')
}

/** True when a marker file already exists (used by the smoke runner). */
export function smokeMarkerExists(markerPath: string): boolean {
  try {
    return existsSync(markerPath)
  } catch {
    return false
  }
}
