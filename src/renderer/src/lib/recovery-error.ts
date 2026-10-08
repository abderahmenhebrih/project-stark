import { getStarkApi } from './stark-api'

/**
 * Renderer-safe recovery error normalization. Never surfaces raw
 * provider bodies, credentials, SQL, or channel names.
 */
export const RECOVERY_GENERIC_MESSAGE = 'We couldn’t continue this request.'

export function normalizeRecoveryError(error: unknown, fallback: string = RECOVERY_GENERIC_MESSAGE): Error {
  if (error instanceof Error && error.message !== '') {
    return new Error(error.message)
  }
  return new Error(fallback)
}

export function getRecoveryBridgeAvailable(): boolean {
  return getStarkApi()?.recovery !== undefined
}
