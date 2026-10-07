import type { StarkApi } from '../../../shared/types'

/**
 * Typed accessor for the preload bridge.
 * Returns undefined when the renderer runs outside Electron
 * (for example a plain Vite preview), so callers can fall back.
 */
export function getStarkApi(): StarkApi | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  return window.stark
}
