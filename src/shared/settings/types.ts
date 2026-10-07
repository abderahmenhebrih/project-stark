/**
 * Shared Settings domain contract.
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs — so every layer can
 * import it. New settings fields are added here with defaults; nothing
 * else in the codebase duplicates this shape.
 */

/** Visual mode. Only 'dark' renders today; 'system' is reserved. */
export type AppearanceMode = 'dark' | 'system'

/** Complete, validated application settings. Always whole, never partial. */
export interface StarkSettings {
  readonly appearance: AppearanceMode
  readonly reduceMotion: boolean
  readonly confirmBeforeDestructiveActions: boolean
}

/**
 * Update payload accepted over IPC. Known fields only — unknown keys are
 * rejected at runtime (TypeScript alone cannot enforce this for IPC data).
 */
export interface SettingsUpdatePatch {
  readonly appearance?: AppearanceMode
  readonly reduceMotion?: boolean
  readonly confirmBeforeDestructiveActions?: boolean
}

/** Settings slice of the preload bridge (see StarkApi in shared/types). */
export interface SettingsApi {
  get: () => Promise<StarkSettings>
  update: (patch: SettingsUpdatePatch) => Promise<StarkSettings>
  reset: () => Promise<StarkSettings>
}
