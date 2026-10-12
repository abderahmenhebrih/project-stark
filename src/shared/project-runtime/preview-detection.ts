/**
 * Shared human-preview detection contract (Stage: Live Review).
 *
 * Pure, unit-testable source truth for deriving a runnable web
 * preview from a workspace's package.json — used by main (which reads
 * the files) and mirrored by the renderer (which never reads them).
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Priority: `dev`, then STARK-recognized preview scripts
 * (`preview`, `serve`), then `start` only when its command clearly
 * describes a local dev/preview server. Nothing is invented: unknown
 * scripts yield no preview.
 */

/** Hard dev-server startup window (explicit Start → URL or timeout). */
export const PREVIEW_STARTUP_TIMEOUT_MS = 25_000

/** Package managers STARK can launch directly (bare program + args, no shell). */
export type PreviewPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** One detected runnable preview: script name plus launch plan. */
export interface DetectedPreview {
  readonly script: string
  readonly packageManager: PreviewPackageManager
  readonly program: string
  readonly args: readonly string[]
}

/** Lockfile presence observed by main (never renderer-supplied). */
export interface PreviewLockfiles {
  readonly pnpmLock: boolean
  readonly yarnLock: boolean
  readonly bunLock: boolean
  readonly npmLock: boolean
}

const RECOGNIZED_PREVIEW_SCRIPTS: readonly string[] = ['preview', 'serve']

/** `start` commands that clearly describe a local dev/preview server. */
/** `start` commands that clearly describe a local dev/preview server (whole words only). */
const DEV_SERVER_COMMAND_PATTERN = /(\bdev\b|\bserve\b|\bpreview\b|\bvite\b|\bnext\b|\bastro\b|\bnuxt\b|\bremix\b|\bsvelte\b|\bgatsby\b|\breact-scripts\b|\bwebpack-dev-server\b|\bparcel\b)/i

function isPlainScripts(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Picks the preview script from parsed package.json scripts (pure).
 * Returns the script name or null when nothing runnable is detected.
 * Script bodies are bounded strings; anything else is ignored.
 */
export function detectPreviewScript(scripts: unknown): string | null {
  if (!isPlainScripts(scripts)) {
    return null
  }
  const body = (name: string): string | null => {
    const raw = scripts[name]
    return typeof raw === 'string' && raw !== '' && raw.length <= 1024 ? raw : null
  }
  if (body('dev') !== null) {
    return 'dev'
  }
  for (const name of RECOGNIZED_PREVIEW_SCRIPTS) {
    if (body(name) !== null) {
      return name
    }
  }
  const start = body('start')
  if (start !== null && DEV_SERVER_COMMAND_PATTERN.test(start)) {
    return 'start'
  }
  return null
}

/**
 * Derives the package manager from source truth (pure): the explicit
 * `packageManager` field wins, then lockfiles (pnpm > yarn > bun >
 * npm), defaulting to npm. Unknown values fall through safely.
 */
export function detectPackageManagerKind(
  packageManagerField: unknown,
  lockfiles: PreviewLockfiles
): PreviewPackageManager {
  if (typeof packageManagerField === 'string' && packageManagerField !== '') {
    const name = packageManagerField.split('@')[0]?.trim().toLowerCase() ?? ''
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') {
      return name
    }
  }
  if (lockfiles.pnpmLock) {
    return 'pnpm'
  }
  if (lockfiles.yarnLock) {
    return 'yarn'
  }
  if (lockfiles.bunLock) {
    return 'bun'
  }
  return 'npm'
}

/**
 * Launch plan for one manager + script: direct executable plus argv
 * (no shell at spawn). `run <script>` works uniformly across all
 * four managers for package.json scripts.
 */
export function packageManagerLaunch(manager: PreviewPackageManager, script: string): { program: string; args: readonly string[] } {
  return { program: manager, args: ['run', script] }
}

/**
 * Full detection from parsed manifest pieces (pure): script priority
 * plus manager derivation. Returns null when nothing runnable exists.
 */
export function detectPreviewPlan(input: {
  readonly scripts: unknown
  readonly packageManagerField: unknown
  readonly lockfiles: PreviewLockfiles
}): DetectedPreview | null {
  const script = detectPreviewScript(input.scripts)
  if (script === null) {
    return null
  }
  const packageManager = detectPackageManagerKind(input.packageManagerField, input.lockfiles)
  const launch = packageManagerLaunch(packageManager, script)
  return { script, packageManager, program: launch.program, args: launch.args }
}

const LOOPBACK_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))([/?#][^\s"'`<>]*)?/gi

/**
 * Discovers the most recent loopback URL with an explicit valid port
 * in bounded dev-server output (Vite, Next, CRA, Astro, Nuxt, and
 * other normal dev servers print these forms). No port scanning —
 * known runtime output only. Returns null when nothing valid appears.
 */
export function parseLoopbackUrlFromText(text: string): string | null {
  if (typeof text !== 'string' || text === '') {
    return null
  }
  const bounded = text.length > 32 * 1024 ? text.slice(text.length - 32 * 1024) : text
  let found: string | null = null
  bounded.replace(LOOPBACK_URL_PATTERN, (match, portText: string) => {
    const port = Number(portText)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      found = match.replace(/[.,;:!?]+$/, '')
    }
    return match
  })
  return found
}
