import type { StarkApi } from '../../../shared/types'

declare global {
  interface Window {
    /** Secure preload bridge. Undefined when running outside Electron. */
    readonly stark?: StarkApi
  }
}

export {}
