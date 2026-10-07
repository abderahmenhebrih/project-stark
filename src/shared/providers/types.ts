/**
 * Shared AI provider domain contracts (Stage 14).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Stage 14 has exactly one network provider: OpenAI. The contracts
 * are provider-neutral so future adapters can register without
 * changing Session/UI/storage foundations. Credentials NEVER appear
 * in any contract below — not plaintext, not encrypted bytes.
 */

/** Known provider IDs. Only 'openai' exists in Stage 14. */
export type ProviderId = 'openai'

/** One discoverable model: ID only, no provider internals. */
export interface ProviderModel {
  readonly id: string
}

/**
 * Renderer-visible provider state. `configured` means an encrypted
 * credential is stored; it says nothing about validity, which only a
 * connection test can establish transiently.
 */
export interface AiProviderState {
  readonly providerId: ProviderId
  readonly displayName: string
  readonly secureStorageAvailable: boolean
  readonly configured: boolean
  readonly selectedModel: string | null
}

/** Credential save request. The key is write-only: never returned. */
export interface SaveProviderCredentialRequest {
  readonly providerId: ProviderId
  readonly apiKey: string
}

/** Provider reference for state/test/list operations. */
export interface ProviderReference {
  readonly providerId: ProviderId
}

/** Model selection request. */
export interface SetProviderModelRequest {
  readonly providerId: ProviderId
  readonly model: string
}

/** Connection test outcome. Transient UI state, never persisted. */
export type ProviderConnectionStatus =
  | 'connected'
  | 'invalid-credential'
  | 'rate-limited'
  | 'network-error'
  | 'timeout'

/**
 * Connection test result. On `connected`, the same single Models API
 * response also supplies the model list so the UI needs no second
 * network call; otherwise the list is empty.
 */
export interface ProviderConnectionResult {
  readonly status: ProviderConnectionStatus
  readonly models: readonly ProviderModel[]
}

/** Provider slice of the preload bridge (`window.stark.providers`). */
export interface ProvidersApi {
  getState: (providerId: ProviderId) => Promise<AiProviderState>
  saveCredential: (request: SaveProviderCredentialRequest) => Promise<AiProviderState>
  clearCredential: (providerId: ProviderId) => Promise<AiProviderState>
  testConnection: (providerId: ProviderId) => Promise<ProviderConnectionResult>
  listModels: (providerId: ProviderId) => Promise<readonly ProviderModel[]>
  setModel: (request: SetProviderModelRequest) => Promise<AiProviderState>
}
