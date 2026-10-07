import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import {
  ProviderGenericError,
  ProviderInvalidCredentialError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  type AiProviderError
} from './errors'

/** One bounded context message handed to a provider. */
export interface ProviderContextMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Provider-neutral text-generation request. No tools, no URLs. */
export interface ProviderGenerateRequest {
  readonly model: string
  readonly instructions: string
  readonly messages: readonly ProviderContextMessage[]
  readonly maxOutputTokens: number
}

/** Provider-neutral text result. Text only. */
export interface ProviderGenerateResult {
  readonly text: string
}

/**
 * Internal provider adapter contract (Stage 14). Adapters live in the
 * main process only and are never exposed to the renderer. API keys
 * stay main-only: adapters receive the decrypted key per call and must
 * not retain, log, or return it.
 */
export interface AiProviderAdapter {
  readonly id: ProviderId
  readonly displayName: string
  listModels(apiKey: string): Promise<readonly ProviderModel[]>
  generateText(request: ProviderGenerateRequest & { readonly apiKey: string }): Promise<ProviderGenerateResult>
}

/**
 * Explicit provider registry. Adapters are registered in code — no
 * dynamic module loading, no renderer-defined providers.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, AiProviderAdapter>()

  register(adapter: AiProviderAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(providerId: ProviderId): AiProviderAdapter | undefined {
    return this.adapters.get(providerId)
  }

  knownIds(): readonly ProviderId[] {
    return [...this.adapters.keys()]
  }

  isKnown(providerId: string): providerId is ProviderId {
    return this.adapters.has(providerId as ProviderId)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Classifies an unknown SDK/transport failure into a safe provider
 * error. Inspects status codes and timeout markers only — raw bodies,
 * headers, and key material are never propagated.
 */
export function classifyProviderError(error: unknown): AiProviderError {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  if (
    status === 401 ||
    (typeof code === 'string' && code === 'invalid_api_key') ||
    lowered.includes('incorrect api key') ||
    lowered.includes('invalid api key')
  ) {
    return new ProviderInvalidCredentialError({ cause: error })
  }
  if (status === 429) {
    return new ProviderRateLimitedError({ cause: error })
  }
  if (status === 404 || (typeof code === 'string' && code === 'model_not_found')) {
    return new ProviderModelUnavailableError({ cause: error })
  }
  if (
    (typeof code === 'string' && (code === 'ETIMEDOUT' || code === 'ECONNABORTED')) ||
    lowered.includes('timed out') ||
    lowered.includes('timeout')
  ) {
    return new ProviderTimeoutError({ cause: error })
  }
  const networkCodes: readonly string[] = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN']
  if (
    (typeof code === 'string' && networkCodes.includes(code)) ||
    error instanceof TypeError ||
    lowered.includes('fetch failed') ||
    lowered.includes('network')
  ) {
    return new ProviderNetworkError({ cause: error })
  }
  if (isRecord(error) && typeof error['model'] === 'string' && lowered.includes('does not exist')) {
    return new ProviderModelUnavailableError({ cause: error })
  }
  return new ProviderGenericError({ cause: error })
}
