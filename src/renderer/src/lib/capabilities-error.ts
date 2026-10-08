import { getStarkApi } from './stark-api'

/**
 * Renderer-safe capability error normalization. Never surfaces SQL,
 * paths, channels, or stack traces.
 */
export const CAPABILITY_GENERIC_MESSAGE = 'We couldn’t save the workspace permissions.'

export function normalizeCapabilityError(error: unknown, fallback: string = CAPABILITY_GENERIC_MESSAGE): Error {
  if (error instanceof Error && error.message !== '') {
    return new Error(error.message)
  }
  return new Error(fallback)
}

export function getCapabilitiesBridgeAvailable(): boolean {
  return getStarkApi()?.capabilities !== undefined
}
