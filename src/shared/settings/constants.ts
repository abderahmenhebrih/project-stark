import type { StarkSettings } from './types'

/**
 * Canonical default settings. Frozen so it cannot be mutated accidentally;
 * every consumer receives a clone (see cloneSettings in main/settings).
 * Do not scatter default literals anywhere else.
 */
export const DEFAULT_SETTINGS: StarkSettings = Object.freeze({
  appearance: 'dark',
  reduceMotion: false,
  confirmBeforeDestructiveActions: true
})
