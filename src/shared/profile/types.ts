/**
 * Shared local-profile domain contract.
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * This is a LOCAL display preference, not an account: no login, no
 * cloud identity, no credentials. Never confuse with future
 * authenticated users.
 */

/** Local profile. Always whole, never partial. */
export interface LocalProfile {
  readonly displayName: string
}

/** Profile slice of the preload bridge (see StarkApi in shared/types). */
export interface ProfileApi {
  get: () => Promise<LocalProfile | null>
  setDisplayName: (displayName: string) => Promise<LocalProfile>
}
