import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  detectPreviewPlan,
  type DetectedPreview,
  type PreviewLockfiles
} from '../../shared/project-runtime/preview-detection'

/** Largest package.json accepted for preview inspection (1 MiB). */
export const MAX_PREVIEW_MANIFEST_BYTES = 1024 * 1024

export type PreviewProjectReason = 'no-package-json' | 'invalid-manifest' | 'no-preview-script'

export type PreviewProjectOutcome =
  | { readonly kind: 'ready'; readonly plan: DetectedPreview }
  | { readonly kind: PreviewProjectReason }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Inspects one workspace root for a runnable web preview (main-owned
 * reads only). Reads package.json as data (bounded, never executed)
 * plus lockfile presence, then applies the shared detection priority
 * (`dev` → `preview`/`serve` → safe `start`). Never invents commands.
 */
export async function readPreviewProject(rootPath: string): Promise<PreviewProjectOutcome> {
  let manifestStats
  try {
    manifestStats = await lstat(join(rootPath, 'package.json'))
  } catch {
    return { kind: 'no-package-json' }
  }
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    return { kind: 'no-package-json' }
  }
  if (manifestStats.size <= 0 || manifestStats.size > MAX_PREVIEW_MANIFEST_BYTES) {
    return { kind: 'invalid-manifest' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf8')) as unknown
  } catch {
    return { kind: 'invalid-manifest' }
  }
  if (!isRecord(parsed)) {
    return { kind: 'invalid-manifest' }
  }
  const lockfiles: PreviewLockfiles = {
    pnpmLock: await existsFile(join(rootPath, 'pnpm-lock.yaml')),
    yarnLock: await existsFile(join(rootPath, 'yarn.lock')),
    bunLock: (await existsFile(join(rootPath, 'bun.lock'))) || (await existsFile(join(rootPath, 'bun.lockb'))),
    npmLock: await existsFile(join(rootPath, 'package-lock.json'))
  }
  const plan = detectPreviewPlan({
    scripts: parsed['scripts'],
    packageManagerField: parsed['packageManager'],
    lockfiles
  })
  if (plan === null) {
    return { kind: 'no-preview-script' }
  }
  return { kind: 'ready', plan }
}

async function existsFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}
