import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Extension Host artifact locations (dev + packaged).
 *
 * Root cause (corrective pass): `out/main` contained only
 * `index.js` — the shipped host artifacts
 * (`extension-host-bootstrap.js`, `generic-host.mjs`, …) were
 * missing, so every `utilityProcess.fork()` exited immediately and
 * the GUI reported `host-unavailable` while standalone Node imports
 * of `generic-host.mjs` looked healthy. The `npm run dev` / `npm run
 * build` scripts copy these files, but a cleaned output directory,
 * a watcher rebuild, or a partial build left the fork path dangling
 * with stderr suppressed (`stdio: ignore`), hiding the cause.
 *
 * Fix: the built main entry (`out/main`) is the single canonical
 * host directory in BOTH dev and packaged runs. Before the manager
 * is constructed, main ensures every artifact exists there —
 * self-healing from the audited source tree in dev
 * (`app.getAppPath()`-derived, never a hardcoded absolute path),
 * and failing with an actionable main-side log in packaged builds
 * (where the source tree is absent and the copy step owns delivery).
 * No renderer internals leak: activation still surfaces the calm
 * `host-unavailable` copy.
 */

/** Audited source file → shipped runtime name (verbatim copies, never bundled). */
export const SHIPPED_HOST_FILES: readonly { src: string; dest: string }[] = [
  { src: 'bootstrap.js', dest: 'extension-host-bootstrap.js' },
  { src: 'generic-host.mjs', dest: 'generic-host.mjs' },
  { src: 'extension-process.mjs', dest: 'extension-process.mjs' },
  { src: 'formatter-host.mjs', dest: 'formatter-host.mjs' },
  { src: 'vscode-shim.mjs', dest: 'vscode-shim.mjs' },
  { src: 'vscode-loader.mjs', dest: 'vscode-loader.mjs' }
]

/** Canonical fork entrypoint name inside the built main directory. */
export const EXTENSION_HOST_BOOTSTRAP_FILE = 'extension-host-bootstrap.js'

/** Whether every shipped host artifact exists in a main directory. */
export function extensionHostArtifactsComplete(mainDir: string): boolean {
  return SHIPPED_HOST_FILES.every((file) => existsQuietly(join(mainDir, file.dest)))
}

function existsQuietly(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** Missing artifact names in a main directory (bounded, renderer-safe labels only). */
export function missingExtensionHostArtifacts(mainDir: string): readonly string[] {
  const missing: string[] = []
  for (const file of SHIPPED_HOST_FILES) {
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
export function ensureExtensionHostArtifacts(mainDir: string, sourceDir: string): readonly string[] {
  const copied: string[] = []
  mkdirSync(mainDir, { recursive: true })
  for (const file of SHIPPED_HOST_FILES) {
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
export function devExtensionHostSourceDir(appPath: string): string {
  return join(appPath, 'src', 'main', 'extension-host')
}
