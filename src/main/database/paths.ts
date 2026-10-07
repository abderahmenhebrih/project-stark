import { join } from 'node:path'

/**
 * Database file location strategy.
 *
 * The live database always lives under Electron's per-user application
 * data directory (app.getPath('userData')), which is portable across
 * Windows, macOS, and Linux — never in the repository working tree.
 *
 * Development uses a separate filename so local dev data can never mix
 * with packaged-production data:
 * - development (unpackaged): stark-dev.db
 * - production (packaged):    stark.db
 */

/** Filename used for packaged production builds. */
export const PROD_DATABASE_FILE = 'stark.db'

/** Filename used for unpackaged development builds. */
export const DEV_DATABASE_FILE = 'stark-dev.db'

/**
 * Resolves the absolute database file path. Pure function of its inputs —
 * never reads the current working directory.
 */
export function resolveDatabaseFile(isPackaged: boolean, userDataDir: string): string {
  return join(userDataDir, isPackaged ? PROD_DATABASE_FILE : DEV_DATABASE_FILE)
}
