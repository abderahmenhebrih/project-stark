import type { AiChangeSetProposalResult, AiFileChangeProposalResult, AiGenerateRequest, AiGenerateResult, AiProposeChangeSetRequest, AiProposeFileChangeRequest, AiRunBrainRequest, AiRunBrainResult, AskRecoveryResult, WorkRecoveryResult } from '../../../shared/ai/types'
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
  return (api(request) as Promise<AskRecoveryResult>).then((outcome) => {
    if (typeof outcome === 'object' && outcome !== null && 'kind' in outcome) {
      if (outcome.kind === 'completed') {
        return outcome.result
      }
      // Recovery outcomes are handled by the session panel via the
      // recovery event lookup; surface the safe provider copy for the
      // source session while the target holds the continued work.
      if (outcome.kind === 'recovery_handoff') {
        throw new Error(recoveryHandoffCopy(outcome.recoveryEvent.status))
      }
      // Recovered: the answer lives in the target session. Resolve with
      // a synthetic completed shape is forbidden (no fake assistant in
      // source) — so throw the handoff copy and let the panel select
      // the target. Direct callers that need the target use the raw API.
      throw new Error(recoveryHandoffCopy(outcome.recoveryEvent.status))
    }
    return outcome as AiGenerateResult
  })
}

function recoveryHandoffCopy(status: string): string {
  switch (status) {
    case 'handoff_ready':
      return 'STARK created a recovery session.'
    case 'running':
      return 'STARK is continuing in a recovery session…'
    case 'succeeded':
      return 'STARK continued this request in a recovery session.'
    case 'failed':
      return 'Recovery attempt failed. No further automatic attempts will be made.'
    default:
      return 'We couldn’t get a response from the AI provider.'
  }
}

/** Raw discriminated Ask result for recovery-aware callers (panel banners). */
export function generateAssistantResponseRaw(request: AiGenerateRequest): Promise<AskRecoveryResult> {
  const api = getStarkApi()?.ai.generateResponse
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t get a response from the AI provider.'))
  }
  return api(request) as Promise<AskRecoveryResult>
}

export function proposeAiFileChange(request: AiProposeFileChangeRequest): Promise<AiFileChangeProposalResult> {
  const api = getStarkApi()?.ai.proposeFileChange
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t prepare this code proposal.'))
  }
  return api(request)
}

export function proposeAiChangeSet(request: AiProposeChangeSetRequest): Promise<AiChangeSetProposalResult> {
  const api = getStarkApi()?.ai.proposeChangeSet
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t prepare this grouped code proposal.'))
  }
  return api(request)
}

export function runBrainWork(request: AiRunBrainRequest): Promise<AiRunBrainResult> {
  const api = getStarkApi()?.ai.runBrain
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t complete this work run.'))
  }
  return (api(request) as Promise<WorkRecoveryResult>).then((outcome) => {
    if (typeof outcome === 'object' && outcome !== null && 'kind' in outcome) {
      if (outcome.kind === 'completed') {
        return outcome.result
      }
      if (outcome.kind === 'waiting_for_approval') {
        throw new Error('STARK needs approval before continuing this work.')
      }
      throw new Error(recoveryHandoffCopy(outcome.recoveryEvent.status))
    }
    return outcome as AiRunBrainResult
  })
}

/** Raw discriminated Work result for recovery-aware callers. */
export function runBrainWorkRaw(request: AiRunBrainRequest): Promise<WorkRecoveryResult> {
  const api = getStarkApi()?.ai.runBrain
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t complete this work run.'))
  }
  return api(request) as Promise<WorkRecoveryResult>
}
