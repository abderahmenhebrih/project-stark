/**
 * Renderer-side error boundary for provider and AI operations.
 *
 * Same principle as the session boundary: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process provider mapping
 * are recognized; provider bodies, headers, key material, channel
 * names, and anything unrecognized collapse to the caller fallback.
 */

export type ProviderErrorKind =
  | 'storage-unavailable'
  | 'credential-missing'
  | 'invalid-credential'
  | 'rate-limited'
  | 'timeout'
  | 'network'
  | 'model-unavailable'
  | 'model-missing'
  | 'in-flight'
  | 'nothing-to-answer'
  | 'generic'

export interface NormalizedProviderError {
  readonly kind: ProviderErrorKind
  readonly message: string
}

/** Stable main-process public messages for provider operations. */
const MAIN_STORAGE_UNAVAILABLE = 'Secure credential storage is not available on this system.'
const MAIN_CREDENTIAL_MISSING = 'No API key is saved for this provider yet.'
const MAIN_INVALID_CREDENTIAL = 'The saved API key was rejected. Check the key and try again.'
const MAIN_RATE_LIMITED = 'The AI provider is rate-limiting requests. Try again shortly.'
const MAIN_TIMEOUT = 'The AI provider request timed out. Try again.'
const MAIN_NETWORK = 'The AI provider could not be reached. Check your connection.'
const MAIN_MODEL_UNAVAILABLE = 'The selected model is not available. Choose another model.'
const MAIN_MODEL_MISSING = 'No AI model is selected yet.'
const MAIN_IN_FLIGHT = 'A response is already being generated.'
const MAIN_NOTHING_TO_ANSWER = 'There is no new message for STARK to answer.'
const MAIN_GENERIC = 'We couldn’t get a response from the AI provider.'

export const PROVIDER_STORAGE_UNAVAILABLE_MESSAGE = MAIN_STORAGE_UNAVAILABLE
export const PROVIDER_CREDENTIAL_MISSING_MESSAGE = MAIN_CREDENTIAL_MISSING
export const PROVIDER_INVALID_CREDENTIAL_MESSAGE = MAIN_INVALID_CREDENTIAL
export const PROVIDER_RATE_LIMITED_MESSAGE = MAIN_RATE_LIMITED
export const PROVIDER_TIMEOUT_MESSAGE = MAIN_TIMEOUT
export const PROVIDER_NETWORK_MESSAGE = MAIN_NETWORK
export const PROVIDER_MODEL_UNAVAILABLE_MESSAGE = MAIN_MODEL_UNAVAILABLE
export const PROVIDER_MODEL_MISSING_MESSAGE = MAIN_MODEL_MISSING
export const PROVIDER_IN_FLIGHT_MESSAGE = MAIN_IN_FLIGHT
export const PROVIDER_NOTHING_TO_ANSWER_MESSAGE = MAIN_NOTHING_TO_ANSWER
export const PROVIDER_GENERIC_MESSAGE = MAIN_GENERIC

const KNOWN_OUTCOMES: readonly { readonly kind: ProviderErrorKind; readonly mainMessage: string }[] = [
  { kind: 'storage-unavailable', mainMessage: MAIN_STORAGE_UNAVAILABLE },
  { kind: 'credential-missing', mainMessage: MAIN_CREDENTIAL_MISSING },
  { kind: 'invalid-credential', mainMessage: MAIN_INVALID_CREDENTIAL },
  { kind: 'rate-limited', mainMessage: MAIN_RATE_LIMITED },
  { kind: 'timeout', mainMessage: MAIN_TIMEOUT },
  { kind: 'network', mainMessage: MAIN_NETWORK },
  { kind: 'model-unavailable', mainMessage: MAIN_MODEL_UNAVAILABLE },
  { kind: 'model-missing', mainMessage: MAIN_MODEL_MISSING },
  { kind: 'in-flight', mainMessage: MAIN_IN_FLIGHT },
  { kind: 'nothing-to-answer', mainMessage: MAIN_NOTHING_TO_ANSWER },
  { kind: 'generic', mainMessage: MAIN_GENERIC }
]

/**
 * Normalizes any thrown provider/AI failure to canonical
 * display-safe copy, falling back to the caller-supplied message.
 */
export function normalizeProviderError(error: unknown, fallback: string = PROVIDER_GENERIC_MESSAGE): NormalizedProviderError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.mainMessage)) {
        return { kind: outcome.kind, message: outcome.mainMessage }
      }
    }
  }
  return { kind: 'generic', message: fallback }
}
