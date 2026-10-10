import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Terminal Host artifact locations (dev + packaged).
 *
 * The built main entry (`out/main`) is the single canonical host
 * directory in BOTH dev and packaged runs: `utilityProcess.fork()`
 * runs `terminal-host-bootstrap.js` from there, which loads the
 * sibling `terminal-host.mjs` runtime. The `npm run dev` / `npm run
 * build` scripts copy these files; a cleaned output directory must
 * never leave the fork path dangling.
 */

/** Audited source file → shipped runtime name (verbatim copies, never bundled). */
export const SHIPPED_TERMINAL_HOST_FILES: readonly { src: string; dest: string }[] = [
  { src: 'terminal-host-bootstrap.js', dest: 'terminal-host-bootstrap.js' },
  { src: 'terminal-host.mjs', dest: 'terminal-host.mjs' }
]

/** Canonical fork entrypoint name inside the built main directory. */
export const TERMINAL_HOST_BOOTSTRAP_FILE = 'terminal-host-bootstrap.js'

/** Whether every shipped host artifact exists in a main directory. */
export function terminalHostArtifactsComplete(mainDir: string): boolean {
  return SHIPPED_TERMINAL_HOST_FILES.every((file) => existsQuietly(join(mainDir, file.dest)))
}

function existsQuietly(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** Missing artifact names in a main directory (bounded, renderer-safe labels only). */
export function missingTerminalHostArtifacts(mainDir: string): readonly string[] {
  const missing: string[] = []
  for (const file of SHIPPED_TERMINAL_HOST_FILES) {
    if (!existsQuietly(join(mainDir, file.dest))) {
      missing.push(file.dest)
    }
  }
  return missing
}

/**
 * Copies missing host artifacts verbatim from the audited source
 * directory into the built main directory. Returns the names that
 * were copied. Throws on I/O failure (caller logs main-side only).
 */
export function ensureTerminalHostArtifacts(mainDir: string, sourceDir: string): readonly string[] {
  const copied: string[] = []
  mkdirSync(mainDir, { recursive: true })
  for (const file of SHIPPED_TERMINAL_HOST_FILES) {
    const dest = join(mainDir, file.dest)
    if (existsQuietly(dest)) {
      continue
    }
    copyFileSync(join(sourceDir, file.src), dest)
    copied.push(file.dest)
  }
  return copied
}

/** Audited host source directory for a dev app path (runtime-derived, never hardcoded). */
export function devTerminalHostSourceDir(appPath: string): string {
  return join(appPath, 'src', 'main', 'terminal')
}
