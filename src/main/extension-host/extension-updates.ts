import type { ValidatedInstallIdentity } from '../extension-install/extension-install-service'

/**
 * Manual extension-update support (Step 9, main-side, pure planning +
 * a bounded registry-backed check).
 *
 * Default policy is MANUAL updates: STARK never auto-installs a new
 * executable version. An optional global setting
 * (`automaticallyUpdateExtensions`, DEFAULT OFF) enables one bounded
 * check per session. Update installs a new version ALONGSIDE the old
 * one through the existing safe installer and only removes the old
 * version after explicit user confirmation — never an unsafe
 * in-place overwrite.
 */

/** Compares two version strings (semver-ish, deterministic). Negative when a < b. */
export function compareExtensionVersions(a: string, b: string): number {
  const parse = (version: string): readonly (number | string)[] =>
    version.split('.').map((part) => {
      const numeric = Number(part)
      return Number.isInteger(numeric) && numeric >= 0 && part !== '' ? numeric : part
    })
  const pa = parse(a)
  const pb = parse(b)
  const length = Math.max(pa.length, pb.length)
  for (let index = 0; index < length; index += 1) {
    const va = pa[index]
    const vb = pb[index]
    if (va === vb) {
      continue
    }
    if (va === undefined) {
      return -1
    }
    if (vb === undefined) {
      return 1
    }
    if (typeof va === 'number' && typeof vb === 'number') {
      return va - vb
    }
    return String(va) < String(vb) ? -1 : 1
  }
  return 0
}

export interface UpdateAvailability {
  readonly updateAvailable: boolean
  /** Latest known version (bounded string) or null when unknown. */
  readonly latestVersion: string | null
}

/**
 * Plans an update from the installed version and a catalog latest
 * version (pure). Downgrades never report as updates.
 */
export function planExtensionUpdate(installedVersion: string, latestVersion: string | null): UpdateAvailability {
  if (typeof installedVersion !== 'string' || installedVersion === '') {
    return { updateAvailable: false, latestVersion: null }
  }
  if (typeof latestVersion !== 'string' || latestVersion === '' || latestVersion.length > 64) {
    return { updateAvailable: false, latestVersion: null }
  }
  if (latestVersion === installedVersion) {
    return { updateAvailable: false, latestVersion }
  }
  return {
    updateAvailable: compareExtensionVersions(installedVersion, latestVersion) < 0,
    latestVersion
  }
}

/** Minimal catalog-version seam (registry service in production, fakes in tests). */
export interface CatalogVersionSource {
  latestVersion(identity: { namespace: string; name: string }): Promise<string | null>
}

/**
 * Checks one installed identity for updates through the catalog seam.
 * Single attempt, no retry; network failures resolve to
 * `{ updateAvailable: false, latestVersion: null }` (offline-safe).
 */
export async function checkExtensionUpdate(
  source: CatalogVersionSource,
  identity: ValidatedInstallIdentity
): Promise<UpdateAvailability> {
  let latest: string | null
  try {
    latest = await source.latestVersion({ namespace: identity.namespace, name: identity.name })
  } catch {
    return { updateAvailable: false, latestVersion: null }
  }
  return planExtensionUpdate(identity.version, latest)
}
