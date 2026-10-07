import type { AiGenerateRequest, AiGenerateResult } from '../../../shared/ai/types'
import type {
  AiProviderState,
  ProviderConnectionResult,
  ProviderId,
  ProviderModel,
  ProvidersApi,
  SaveProviderCredentialRequest,
  SetProviderModelRequest
} from '../../../shared/providers/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessors for the provider and AI domains.
 * Same Electron-only availability as the bridge itself.
 */
export function getProvidersApi(): ProvidersApi | undefined {
  return getStarkApi()?.providers
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('AI provider settings are unavailable.'))
}

/**
 * Typed provider callers. Components use these helpers instead of
 * direct `window.stark.providers` access, mirroring the session
 * helpers. No polling here — callers fetch explicitly.
 */
export function getProviderState(providerId: ProviderId): Promise<AiProviderState> {
  const api = getProvidersApi()?.getState
  if (api === undefined) {
    return unavailable()
  }
  return api(providerId)
}

export function saveProviderCredential(request: SaveProviderCredentialRequest): Promise<AiProviderState> {
  const api = getProvidersApi()?.saveCredential
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function clearProviderCredential(providerId: ProviderId): Promise<AiProviderState> {
  const api = getProvidersApi()?.clearCredential
  if (api === undefined) {
    return unavailable()
  }
  return api(providerId)
}

export function testProviderConnection(providerId: ProviderId): Promise<ProviderConnectionResult> {
  const api = getProvidersApi()?.testConnection
  if (api === undefined) {
    return unavailable()
  }
  return api(providerId)
}

export function listProviderModels(providerId: ProviderId): Promise<readonly ProviderModel[]> {
  const api = getProvidersApi()?.listModels
  if (api === undefined) {
    return unavailable()
  }
  return api(providerId)
}

export function setProviderModel(request: SetProviderModelRequest): Promise<AiProviderState> {
  const api = getProvidersApi()?.setModel
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function generateAssistantResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
  const api = getStarkApi()?.ai.generateResponse
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t get a response from the AI provider.'))
  }
  return api(request)
}
