import OpenAI from 'openai'
import { AI_GENERATE_TIMEOUT_MS, MAX_PROVIDER_MODELS, PROVIDER_REQUEST_TIMEOUT_MS } from './limits'
import {
  classifyProviderError,
  type AiProviderAdapter,
  type ConnectionDiagnosis,
  type ProviderGenerateRequest,
  type ProviderStructuredRequest,
  type SafePathDiagnosis
} from './provider-adapter'
import { normalizeProviderUsage } from '../usage/ai-usage-types'
import type { ProviderUsage } from '../usage/ai-usage-types'
import type { ProviderModel } from '../../shared/providers/types'
import {
  ProviderEmptyResponseError,
  ProviderForbiddenError,
  ProviderInvalidCredentialError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderStructuredOutputUnsupportedError,
  ProviderTimeoutError
} from './errors'

/**
 * Minimal structural surface of the official OpenAI SDK used by the
 * adapter. The production factory returns the real client; tests
 * inject mocks of this shape — no network in unit tests.
 */
export interface OpenAiModelsClient {
  list(options?: { timeout?: number; maxRetries?: number }): Promise<{ data: readonly { id: string }[] } | AsyncIterable<{ id: string }>>
}

export interface OpenAiResponsesClient {
  create(
    params: {
      model: string
      instructions: string
      input: readonly { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }[]
      max_output_tokens: number
      store: boolean
      text?: unknown
    },
    options?: { timeout?: number; maxRetries?: number }
  ): Promise<{
    output_text?: string
    output?: readonly unknown[]
    usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
  }>
}

/** Maps a Responses-API usage block to ProviderUsage (null when unreported). */
function readResponseUsage(response: {
  usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
}): ProviderUsage | null {
  if (response.usage === undefined) {
    return null
  }
  const normalized = normalizeProviderUsage({
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    total_tokens: response.usage.total_tokens
  })
  if (normalized.inputTokens === null && normalized.outputTokens === null && normalized.totalTokens === null) {
    return null
  }
  return normalized
}

export interface OpenAiClientLike {
  readonly models: OpenAiModelsClient
  readonly responses: OpenAiResponsesClient
}

export type OpenAiClientFactory = (apiKey: string) => OpenAiClientLike

/**
 * Safe, secret-free outcome of one diagnostic transport path.
 * Statuses and booleans only — never bodies, headers, or keys.
 * (Canonical shape lives in provider-adapter.ts; re-exported here
 * for the diagnostic call sites.)
 */
export type { SafePathDiagnosis, ConnectionDiagnosis } from './provider-adapter'

/**
 * Production factory: fixed official endpoint, no inherited
 * organization/project, no retries, bounded timeout.
 *
 * Every client option is explicit because the official SDK inherits
 * OPENAI_BASE_URL / OPENAI_ORG_ID / OPENAI_PROJECT_ID /
 * OPENAI_API_KEY from the environment when omitted — a stale shell
 * export (proxy URL, wrong org/project scope) would otherwise
 * silently redirect or de-authorize the stored key. process.env is
 * never mutated; unrelated variables are untouched.
 */
export function createOpenAiClient(apiKey: string): OpenAiClientLike {
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.openai.com/v1',
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: PROVIDER_REQUEST_TIMEOUT_MS
  }) as unknown as OpenAiClientLike
}

function extractOutputText(response: { output_text?: string; output?: readonly unknown[] }): string | null {
  if (typeof response.output_text === 'string' && response.output_text !== '') {
    return response.output_text
  }
  // Fallback: walk output items for message/output_text blocks without
  // ever persisting provider-internal structures.
  const chunks: string[] = []
  for (const item of response.output ?? []) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as Record<string, unknown>
    const content = record['content']
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (typeof block !== 'object' || block === null) {
        continue
      }
      const part = block as Record<string, unknown>
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
        chunks.push(part['text'])
      }
    }
  }
  return chunks.length > 0 ? chunks.join('') : null
}

/**
 * Stage 14's only network adapter: OpenAI. Main process only, fixed
 * official endpoint (renderer can never supply a base URL), zero
 * SDK retries, bounded per-request timeouts, Responses API with
 * `store: false`, no tools, no conversations, no
 * `previous_response_id`. Secrets stay main-only: the key arrives per
 * call and is never retained, logged, or returned.
 */
export class OpenAiProviderAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'

  constructor(private readonly clients: OpenAiClientFactory = createOpenAiClient) {}

  async listModels(apiKey: string): Promise<readonly ProviderModel[]> {
    try {
      const page = await this.clients(apiKey).models.list({ timeout: PROVIDER_REQUEST_TIMEOUT_MS, maxRetries: 0 })
      const items = Symbol.asyncIterator in Object(page) ? await collectAsync(page as AsyncIterable<{ id: string }>) : [...(page as { data: readonly { id: string }[] }).data]
      return items
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
        .sort()
        .slice(0, MAX_PROVIDER_MODELS)
        .map((id) => ({ id }))
    } catch (error) {
      throw classifyProviderError(error)
    }
  }

  async generateText(
    request: ProviderGenerateRequest & { readonly apiKey: string }
  ): Promise<{ text: string; usage: ProviderUsage | null }> {
    try {
      const response = await this.clients(request.apiKey).responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.messages.map((entry) => ({ role: entry.role, content: entry.content })),
          max_output_tokens: request.maxOutputTokens,
          store: false
        },
        { timeout: AI_GENERATE_TIMEOUT_MS, maxRetries: 0 }
      )
      const text = extractOutputText(response)
      if (text === null || text === '') {
        throw new ProviderEmptyResponseError()
      }
      return { text, usage: readResponseUsage(response) }
    } catch (error) {
      if (error instanceof ProviderEmptyResponseError) {
        throw error
      }
      throw classifyProviderError(error)
    }
  }

  /**
   * Structured generation via Responses Structured Outputs (Stage 16):
   * exactly one attempt, `text.format` json_schema strict, `store:
   * false`, no tools, no conversations, no `previous_response_id`.
   * Returns the raw JSON envelope text for the caller to parse and
   * validate. Models without structured support surface as
   * `ProviderStructuredOutputUnsupportedError`.
   */
  async generateStructured(
    request: ProviderStructuredRequest & { readonly apiKey: string }
  ): Promise<{ outputText: string; usage: ProviderUsage | null }> {
    try {
      const response = await this.clients(request.apiKey).responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.messages.map((entry) => ({ role: entry.role, content: entry.content })),
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              schema: request.schema,
              strict: true
            }
          }
        },
        { timeout: AI_GENERATE_TIMEOUT_MS, maxRetries: 0 }
      )
      const text = extractOutputText(response)
      if (text === null || text === '') {
        throw new ProviderEmptyResponseError()
      }
      return { outputText: text, usage: readResponseUsage(response) }
    } catch (error) {
      if (error instanceof ProviderEmptyResponseError) {
        throw error
      }
      if (isStructuredUnsupported(error)) {
        throw new ProviderStructuredOutputUnsupportedError({ cause: error })
      }
      throw classifyProviderError(error)
    }
  }

  /**
   * TEMPORARY Stage 14C diagnostic — dev-only, caller-gated, remove
   * after root cause is identified. Runs the SAME decrypted in-memory
   * credential through two transports sequentially (SDK models.list
   * once, then native fetch to the fixed endpoint once), one attempt
   * each, no retries, and logs ONLY secret-free booleans/statuses.
   * Returns the Path A outcome so the caller reuses it instead of a
   * further call.
   */
  async diagnoseConnection(apiKey: string): Promise<ConnectionDiagnosis> {
    const client = this.clients(apiKey)
    const origin = readOrigin((client as { baseURL?: unknown }).baseURL)
    let sdk: SafePathDiagnosis
    let outcome: { models: readonly ProviderModel[] } | { error: unknown }
    try {
      const page = await client.models.list({ timeout: PROVIDER_REQUEST_TIMEOUT_MS, maxRetries: 0 })
      const items = Symbol.asyncIterator in Object(page) ? await collectAsync(page as AsyncIterable<{ id: string }>) : [...(page as { data: readonly { id: string }[] }).data]
      const models = items
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
        .sort()
        .slice(0, MAX_PROVIDER_MODELS)
        .map((id) => ({ id }))
      sdk = { succeeded: true, status: 200, category: 'ok', origin, requestIdPresent: false, contentTypeJson: false }
      outcome = { models }
    } catch (error) {
      const classified = classifyProviderError(error)
      const failure = readSdkFailure(error)
      sdk = {
        succeeded: false,
        status: failure.status,
        category: categoryOf(classified),
        origin,
        requestIdPresent: failure.requestIdPresent,
        contentTypeJson: false
      }
      outcome = { error: classified }
    }
    const native = await diagnoseNativeFetchPath(apiKey)
    console.log(
      '[STARK AI DIAGNOSTIC] ' +
        `sdkSucceeded=${String(sdk.succeeded)} sdkStatus=${sdk.status === null ? 'none' : String(sdk.status)} ` +
        `sdkCategory=${sdk.category} sdkOrigin=${sdk.origin} sdkRequestIdPresent=${String(sdk.requestIdPresent)} ` +
        `nativeSucceeded=${String(native.succeeded)} nativeStatus=${native.status === null ? 'none' : String(native.status)} ` +
        `nativeOrigin=${native.origin} nativeContentTypeJson=${String(native.contentTypeJson)} ` +
        `nativeRequestIdPresent=${String(native.requestIdPresent)} sameCredentialForBothPaths=true`
    )
    return { sdk, native, sameCredentialForBothPaths: true as const, outcome }
  }
}

function readOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown'
  }
  try {
    return new URL(value).origin
  } catch {
    return 'unknown'
  }
}

function categoryOf(error: unknown): string {
  if (error instanceof ProviderInvalidCredentialError) {
    return 'invalid-credential'
  }
  if (error instanceof ProviderForbiddenError) {
    return 'forbidden'
  }
  if (error instanceof ProviderRateLimitedError) {
    return 'rate-limited'
  }
  if (error instanceof ProviderTimeoutError) {
    return 'timeout'
  }
  if (error instanceof ProviderNetworkError) {
    return 'network-error'
  }
  if (error instanceof ProviderModelUnavailableError) {
    return 'model-unavailable'
  }
  return 'generic'
}

/** Reads SDK error metadata without touching bodies or headers beyond presence. */
function readSdkFailure(error: unknown): { status: number | null; requestIdPresent: boolean } {
  if (typeof error !== 'object' || error === null) {
    return { status: null, requestIdPresent: false }
  }
  const record = error as { status?: unknown; requestID?: unknown; headers?: { get?: unknown } }
  const status = typeof record.status === 'number' ? record.status : null
  const requestIdPresent =
    record.requestID !== undefined ||
    (typeof record.headers?.get === 'function' &&
      (() => {
        try {
          return (record.headers as { get: (name: string) => string | null }).get('x-request-id') !== null
        } catch {
          return false
        }
      })())
  return { status, requestIdPresent }
}

async function diagnoseNativeFetchPath(apiKey: string): Promise<SafePathDiagnosis> {
  const url = 'https://api.openai.com/v1/models'
  const origin = readOrigin(url)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)
    })
    const contentType = response.headers.get('content-type') ?? ''
    const diagnosis: SafePathDiagnosis = {
      succeeded: response.ok,
      status: response.status,
      category: response.ok ? 'ok' : categoryOf(classifyProviderError({ status: response.status })),
      origin: readOrigin(response.url),
      requestIdPresent: response.headers.get('x-request-id') !== null,
      contentTypeJson: contentType.toLowerCase().startsWith('application/json')
    }
    return diagnosis
  } catch (error) {
    const classified = classifyProviderError(error)
    return {
      succeeded: false,
      status: null,
      category: categoryOf(classified),
      origin,
      requestIdPresent: false,
      contentTypeJson: false
    }
  }
}

/** Detects a model/endpoint refusal of the structured-output format (no model-name filtering). */
function isStructuredUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined
  const markers = ['json_schema', 'json-schema', 'response_format', 'response format', 'text.format', 'structured output']
  const mentionsFormat = markers.some((marker) => message.includes(marker))
  if (status === 400 && mentionsFormat) {
    return true
  }
  if (message.includes('structured outputs are not supported') || message.includes('unsupported value:')) {
    return mentionsFormat || message.includes('text')
  }
  return false
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const entry of iterable) {
    items.push(entry)
  }
  return items
}
