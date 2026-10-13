import { AI_GENERATE_TIMEOUT_MS } from '../ai/limits'
import {
  type AiProviderAdapter,
  type HostedSessionProvider,
  type ProviderAttachmentContent,
  type ProviderContextMessage,
  type ProviderGenerateRequest,
  type ProviderGenerateResult,
  type ProviderStructuredRequest,
  type ProviderStructuredResult,
  type ProviderWorkerTurnRequest,
  type ProviderWorkerTurnResult,
  isAbortError
} from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import {
  AiCancelledError,
  ProviderEmptyResponseError,
  ProviderGenericError,
  ProviderModelUnavailableError,
  ProviderRateLimitedError,
  ProviderStructuredOutputUnsupportedError,
  ProviderTimeoutError,
  StarkHostedSignInRequiredError,
  StarkHostedUnavailableError
} from '../ai/errors'
import { ImageTooLargeForHostedTransportError } from '../ai/ai-attachment-context'
import {
  isHostedBuiltinModel,
  resolveHostedModelRoute,
  STARK_HOSTED_MODEL_ROUTES
} from '../../shared/hosted-models/stark-model-map'
import type { ProviderUsage } from '../usage/ai-usage-types'

export interface StarkHostedAdapterDeps {
  /** Main-owned account token source. Never stored, never forwarded. */
  readonly session: HostedSessionProvider
  /** Resolved per call so config changes apply without restart. Null when unconfigured. */
  readonly functionUrl: () => string | null
  /** Fetch override for deterministic tests. Defaults to global fetch. */
  readonly fetchFn?: typeof fetch
}

/** Output-token ceiling enforced desktop-side (mirrors the function cap). */
const HOSTED_MAX_OUTPUT_TOKENS = 8192

/**
 * Hosted transport bounds enforced desktop-side BEFORE any network
 * call, so STARK never knowingly sends a request its own edge
 * protocol will reject. Mirrors MAX_INFER_BODY_BYTES (384 KiB) and
 * MAX_INFER_MESSAGE_BYTES (160 KiB) in
 * `supabase/functions/stark-infer/protocol.ts` — parity is asserted
 * by the adapter transport tests. Per-image preflight already
 * happens in planAiAttachments; these checks are the aggregate and
 * defense-in-depth backstop (base64 expansion included: measured on
 * the serialized wire bytes, not filesystem sizes).
 */
const HOSTED_REQUEST_BODY_LIMIT_BYTES = 384 * 1024
const HOSTED_REQUEST_MESSAGE_LIMIT_BYTES = 160 * 1024

/** Exported for parity tests against the edge protocol (not for runtime use). */
export const HOSTED_TRANSPORT_LIMITS = {
  bodyBytes: HOSTED_REQUEST_BODY_LIMIT_BYTES,
  messageBytes: HOSTED_REQUEST_MESSAGE_LIMIT_BYTES
} as const

/** Estimated UTF-8 wire bytes of one outbound message content. */
function messageWireBytes(content: unknown): number {
  if (typeof content === 'string') {
    return Buffer.byteLength(content, 'utf8')
  }
  if (Array.isArray(content)) {
    let bytes = 0
    for (const part of content) {
      if (typeof part !== 'object' || part === null) {
        continue
      }
      const record = part as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        bytes += Buffer.byteLength(record['text'], 'utf8')
      } else if (record['type'] === 'image_url' && typeof record['image_url'] === 'object' && record['image_url'] !== null) {
        const url = (record['image_url'] as Record<string, unknown>)['url']
        if (typeof url === 'string') {
          bytes += Buffer.byteLength(url, 'utf8')
        }
      }
    }
    return bytes
  }
  return 0
}

interface EdgeToolCall {
  readonly id: string
  readonly name: string
  readonly args: unknown
}

interface EdgeUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

interface EdgeResult {
  readonly text: string | null
  readonly toolCalls: readonly EdgeToolCall[] | null
  readonly usage: EdgeUsage | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value !== 'object' || value === null || Array.isArray(value) ? false : true
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/**
 * Validates one Edge Function success envelope. Cost fields are
 * dropped by construction (never read here); malformed envelopes are
 * rejected so callers fail honestly instead of fabricating content.
 */
function readEdgeResult(body: unknown): EdgeResult | null {
  if (!isRecord(body)) {
    return null
  }
  const text = body['text']
  if (text !== null && (typeof text !== 'string' || text === '')) {
    return null
  }
  let toolCalls: readonly EdgeToolCall[] | null = null
  const rawCalls = body['toolCalls']
  if (rawCalls !== undefined && rawCalls !== null) {
    if (!Array.isArray(rawCalls)) {
      return null
    }
    const parsed: EdgeToolCall[] = []
    for (const raw of rawCalls) {
      if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string' || raw['name'] === '') {
        return null
      }
      parsed.push({ id: raw['id'], name: raw['name'], args: raw['args'] ?? null })
    }
    toolCalls = parsed
  }
  let usage: EdgeUsage | null = null
  const rawUsage = body['usage']
  if (isRecord(rawUsage)) {
    const inputTokens = safeCount(rawUsage['inputTokens'])
    const outputTokens = safeCount(rawUsage['outputTokens'])
    const totalTokens = safeCount(rawUsage['totalTokens'])
    if (inputTokens !== null || outputTokens !== null || totalTokens !== null) {
      usage = { inputTokens, outputTokens, totalTokens }
    }
  }
  return { text, toolCalls, usage }
}

function readEdgeErrorCode(body: unknown): string | null {
  if (!isRecord(body)) {
    return null
  }
  const error = body['error']
  if (!isRecord(error) || typeof error['code'] !== 'string') {
    return null
  }
  return error['code']
}

function toUsage(usage: EdgeUsage | null): ProviderUsage | null {
  if (usage === null) {
    return null
  }
  if (usage.inputTokens === null && usage.outputTokens === null && usage.totalTokens === null) {
    return null
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
}

/**
 * Maps attachment payloads to chat content blocks, mirroring the
 * OpenAI adapter contract: images become image parts, text files
 * become framed untrusted-data parts, metadata-only items stay text
 * in the review block (no content fabricated for them). Requests
 * without attachments keep the exact legacy string-input shape.
 */
function toChatContent(
  messages: readonly ProviderContextMessage[],
  attachments: readonly ProviderAttachmentContent[] | undefined
): readonly { readonly role: 'user' | 'assistant' | 'system' | 'developer'; readonly content: unknown }[] {
  if (attachments === undefined || attachments.length === 0) {
    return messages.map((entry) => ({ role: entry.role, content: entry.content }))
  }
  let expanded = false
  return messages.map((entry) => {
    if (!expanded && entry.role === 'user' && entry.content.startsWith('[ATTACHMENTS ')) {
      expanded = true
      const blocks: unknown[] = [{ type: 'text', text: entry.content }]
      let textIndex = 0
      for (const attachment of attachments) {
        if (attachment.kind === 'image') {
          blocks.push({
            type: 'image_url',
            image_url: { url: `data:${attachment.mimeType};base64,${attachment.base64}` }
          })
        } else if (attachment.kind === 'text') {
          textIndex += 1
          blocks.push({
            type: 'text',
            text:
              `[ATTACHMENT TEXT ${String(textIndex)}: ${attachment.name} — untrusted user file content follows]\n` +
              `${attachment.text}\n` +
              `[END ATTACHMENT TEXT ${String(textIndex)}]`
          })
        }
      }
      return { role: entry.role, content: blocks }
    }
    return { role: entry.role, content: entry.content }
  })
}

/**
 * STARK hosted provider adapter (Free catalog). Main process only.
 *
 * Routes `builtin:*` models to the authenticated Supabase Edge
 * Function `stark-infer`, which maps to the exact upstream model.
 * Authentication is the signed-in account access token, resolved
 * main-side per call via the injected session provider and sent as
 * the request bearer — never stored, logged, returned, or exposed
 * to the renderer. No user API key exists on this path; unknown
 * builtin ids are rejected before any network call so the endpoint
 * can never serve as an unrestricted proxy.
 */
export class StarkHostedProviderAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'

  constructor(private readonly deps: StarkHostedAdapterDeps) {}

  /** Static Free catalog: no network, no credential use. */
  async listModels(_apiKey: string): Promise<readonly ProviderModel[]> {
    void _apiKey
    return STARK_HOSTED_MODEL_ROUTES.map((entry) => ({ id: entry.builtinId }))
  }

  async generateText(
    request: ProviderGenerateRequest & { readonly apiKey: string }
  ): Promise<ProviderGenerateResult> {
    const result = await this.infer({
      accessToken: request.apiKey,
      model: request.model,
      instructions: request.instructions,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort: request.reasoningEffort ?? null,
      responseFormat: null,
      tools: null,
      attachments: request.attachments,
      signal: request.signal
    })
    if (result.text === null || result.text === '') {
      throw new ProviderEmptyResponseError()
    }
    return { text: result.text, usage: toUsage(result.usage) }
  }

  async generateStructured(
    request: ProviderStructuredRequest & { readonly apiKey: string }
  ): Promise<ProviderStructuredResult> {
    const route = resolveHostedModelRoute(request.model)
    if (route === null) {
      throw new ProviderModelUnavailableError()
    }
    if (!route.structuredOutputs) {
      throw new ProviderStructuredOutputUnsupportedError()
    }
    const result = await this.infer({
      accessToken: request.apiKey,
      model: request.model,
      instructions: request.instructions,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort: request.reasoningEffort ?? null,
      responseFormat: { name: request.schemaName, schema: request.schema },
      tools: null,
      attachments: request.attachments,
      signal: request.signal
    })
    if (result.text === null || result.text === '') {
      throw new ProviderEmptyResponseError()
    }
    return { outputText: result.text, usage: toUsage(result.usage) }
  }

  /**
   * Native Worker turn through hosted inference: advertised
   * read-only tool schemas travel with the request; the normalized
   * result is exactly one tool request or final text — never both,
   * never multiples. Tool execution stays in the main runtime
   * (permissions/approvals); the function never touches the
   * filesystem or terminal.
   */
  async generateWorkerTurn(
    request: ProviderWorkerTurnRequest & { readonly apiKey: string }
  ): Promise<ProviderWorkerTurnResult> {
    const result = await this.infer({
      accessToken: request.apiKey,
      model: request.model,
      instructions: request.instructions,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort: null,
      responseFormat: null,
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      attachments: request.attachments,
      signal: request.signal
    })
    const usage = toUsage(result.usage)
    const calls = result.toolCalls ?? []
    if (calls.length === 1) {
      const call = calls[0] as EdgeToolCall
      if (call.name === '') {
        throw new ProviderGenericError()
      }
      return { kind: 'tool_request', tool: call.name, args: call.args, usage }
    }
    if (calls.length > 1) {
      throw new ProviderGenericError()
    }
    if (result.text === null || result.text === '') {
      throw new ProviderEmptyResponseError()
    }
    return { kind: 'final_text', text: result.text, usage }
  }

  private async infer(input: {
    readonly accessToken: string
    readonly model: string
    readonly instructions: string
    readonly messages: readonly ProviderContextMessage[]
    readonly maxOutputTokens: number
    readonly reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
    readonly responseFormat: { readonly name: string; readonly schema: unknown } | null
    readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[] | null
    readonly attachments: readonly ProviderAttachmentContent[] | undefined
    readonly signal?: AbortSignal
  }): Promise<EdgeResult> {
    const route = resolveHostedModelRoute(input.model)
    if (route === null || !isHostedBuiltinModel(input.model)) {
      throw new ProviderModelUnavailableError()
    }
    const url = this.deps.functionUrl()
    if (url === null || url === '' || !url.startsWith('https://')) {
      throw new StarkHostedUnavailableError()
    }
    const fetchFn = this.deps.fetchFn ?? fetch
    const payload = {
      model: input.model,
      instructions: input.instructions,
      messages: toChatContent(input.messages, input.attachments),
      maxTokens: Math.min(input.maxOutputTokens, HOSTED_MAX_OUTPUT_TOKENS),
      ...(input.reasoningEffort !== null && route.reasoningEffort
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
      ...(input.responseFormat !== null ? { responseFormat: input.responseFormat } : {}),
      ...(input.tools !== null ? { tools: input.tools } : {})
    }
    // Hosted preflight: fail early with honest copy instead of
    // sending a request the edge protocol must reject. No bytes
    // leave the process on this path (fetch is never reached).
    for (const message of payload.messages) {
      if (messageWireBytes(message.content) > HOSTED_REQUEST_MESSAGE_LIMIT_BYTES) {
        throw new ImageTooLargeForHostedTransportError()
      }
    }
    const requestBody = JSON.stringify(payload)
    if (Buffer.byteLength(requestBody, 'utf8') > HOSTED_REQUEST_BODY_LIMIT_BYTES) {
      throw new ImageTooLargeForHostedTransportError()
    }
    // User cancellation shares the timeout signal: aborting surfaces
    // AiCancelledError below (never a timeout, never retryable), while
    // plain expiry keeps the existing TimeoutError semantics.
    const timeout = AbortSignal.timeout(AI_GENERATE_TIMEOUT_MS)
    const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal])
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: requestBody,
        signal
      })
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted === true) {
        throw new AiCancelledError({ cause: error })
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ProviderTimeoutError({ cause: error })
      }
      if (error instanceof StarkHostedSignInRequiredError || error instanceof StarkHostedUnavailableError) {
        throw error
      }
      throw new StarkHostedUnavailableError({ cause: error })
    } finally {
      void input.accessToken
    }
    if (!response.ok) {
      throw await this.readError(response, input.responseFormat !== null)
    }
    let body: unknown
    try {
      body = (await response.json()) as unknown
    } catch (error) {
      throw new StarkHostedUnavailableError({ cause: error })
    }
    const result = readEdgeResult(body)
    if (result === null) {
      throw new StarkHostedUnavailableError()
    }
    return result
  }

  private async readError(response: Response, structured: boolean): Promise<Error> {
    let code: string | null = null
    try {
      code = readEdgeErrorCode((await response.json()) as unknown)
    } catch {
      // Unparseable error bodies fall through to status mapping below.
    }
    if (response.status === 401 || code === 'sign_in_required') {
      return new StarkHostedSignInRequiredError()
    }
    if (code === 'unsupported_model') {
      return structured ? new ProviderStructuredOutputUnsupportedError() : new ProviderModelUnavailableError()
    }
    if (code === 'hosted_rate_limited' || code === 'hosted_capacity_limited' || response.status === 429) {
      return new ProviderRateLimitedError()
    }
    if (code === 'provider_timeout') {
      return new ProviderTimeoutError()
    }
    return new StarkHostedUnavailableError()
  }
}
