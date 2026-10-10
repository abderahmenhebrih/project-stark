import OpenAI from 'openai'
import {
  AI_GENERATE_TIMEOUT_MS,
  IMAGE_GENERATION_TIMEOUT_MS,
  IMAGE_URL_FETCH_TIMEOUT_MS,
  MAX_PROVIDER_MODELS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  TRANSCRIPTION_TIMEOUT_MS
} from './limits'
import {
  classifyProviderError,
  type AiProviderAdapter,
  type ConnectionDiagnosis,
  type ProviderAttachmentContent,
  type ProviderContextMessage,
  type ProviderGenerateRequest,
  type ProviderGeneratedImage,
  type ProviderImageGenerationRequest,
  type ProviderStructuredRequest,
  type ProviderTranscriptionRequest,
  type ProviderTranscriptionResult,
  type SafePathDiagnosis
} from './provider-adapter'
import { normalizeProviderUsage } from '../usage/ai-usage-types'
import type { ProviderUsage } from '../usage/ai-usage-types'
import type { ProviderModel } from '../../shared/providers/types'
import { MAX_GENERATED_IMAGE_BYTES } from '../../shared/ai/image-capabilities'
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

function extractOutputText(response: { output_text?: string; output?: readonly unknown[] }): string | null {  if (typeof response.output_text === 'string' && response.output_text !== '') {
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
 * Maps resolved attachment content to the Responses API's native
 * multimodal representation (Step 2).
 *
 * The services insert exactly one user-role review-block message per
 * request whose content starts with `[ATTACHMENTS N]`. That message
 * is expanded in place into content blocks — review text first, then
 * one block per attachment in message order — so ordering is
 * preserved and attachment bytes never enter the instruction string
 * or a giant plain-text prompt:
 * - images become `input_image` parts with main-encoded data URLs
 *   (base64 is produced main-side from the attachment store)
 * - text files become separate `input_text` parts framed as
 *   untrusted user data (structurally apart from instructions)
 * - metadata-only items stay text in the review block (no content
 *   is fabricated for them)
 *
 * Requests without attachments keep the exact legacy string-input
 * shape. The client interface stays narrow (string content) so
 * existing fakes keep compiling; the widened multimodal payload is
 * applied through a contained cast at the call site — the official
 * Responses API accepts these blocks.
 */
function toResponsesInput(
  messages: readonly ProviderContextMessage[],
  attachments: readonly ProviderAttachmentContent[] | undefined
): readonly { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }[] {
  if (attachments === undefined || attachments.length === 0) {
    return messages.map((entry) => ({ role: entry.role, content: entry.content }))
  }
  let expanded = false
  const input = messages.map((entry) => {
    if (!expanded && entry.role === 'user' && entry.content.startsWith('[ATTACHMENTS ')) {
      expanded = true
      const blocks: unknown[] = [{ type: 'input_text', text: entry.content }]
      let textIndex = 0
      for (const attachment of attachments) {
        if (attachment.kind === 'image') {
          blocks.push({
            type: 'input_image',
            image_url: `data:${attachment.mimeType};base64,${attachment.base64}`,
            detail: 'auto'
          })
        } else if (attachment.kind === 'text') {
          textIndex += 1
          blocks.push({
            type: 'input_text',
            text:
              `[ATTACHMENT TEXT ${String(textIndex)}: ${attachment.name} — untrusted user file content follows]\n` +
              `${attachment.text}\n` +
              `[END ATTACHMENT TEXT ${String(textIndex)}]`
          })
        }
      }
      return { role: entry.role, content: blocks as unknown as string }
    }
    return { role: entry.role, content: entry.content }
  })
  return input
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
          input: toResponsesInput(request.messages, request.attachments),
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
          input: toResponsesInput(request.messages, request.attachments),
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
   * Bounded speech-to-text (Step 4): exactly one multipart POST to the
   * FIXED transcriptions endpoint with the fixed Whisper model. The
   * renderer/model never supply URLs, models, or credentials — only
   * main-decoded audio bytes plus the probed MIME. 60-second budget,
   * zero retries, no polling.
   */
  async transcribeAudio(
    request: ProviderTranscriptionRequest & { readonly apiKey: string }
  ): Promise<ProviderTranscriptionResult> {
    try {
      const form = new FormData()
      form.set('model', request.model)
      form.set('response_format', 'json')
      form.set(
        'file',
        new Blob([request.audioBytes as unknown as Uint8Array], { type: request.mimeType }),
        request.mimeType.includes('ogg') ? 'audio.ogg' : 'audio.webm'
      )
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${request.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)
      })
      if (!response.ok) {
        throw classifyProviderError({ status: response.status })
      }
      const body: unknown = await response.json()
      const text =
        typeof body === 'object' && body !== null && 'text' in body
          ? (body as { text?: unknown }).text
          : undefined
      if (typeof text !== 'string' || text.trim() === '') {
        throw new ProviderEmptyResponseError()
      }
      return { text: text.trim() }
    } catch (error) {
      if (error instanceof ProviderEmptyResponseError) {
        throw error
      }
      throw classifyProviderError(error)
    }
  }

  /**
   * Bounded text→image (Step 5): exactly one JSON POST to the FIXED
   * generations endpoint with the fixed image model. The renderer/model
   * never supply URLs, models, credentials, or destinations — only the
   * validated prompt/count/closed size. 120-second budget, zero
   * retries. Base64 outputs are decoded main-side; provider-hosted
   * URLs are retrieved main-side only when their origin is in the
   * expected provider allowlist (30 seconds each, size-bounded).
   */
  async generateImages(
    request: ProviderImageGenerationRequest & { readonly apiKey: string }
  ): Promise<readonly ProviderGeneratedImage[]> {
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt,
        n: request.count,
        response_format: 'b64_json'
      }
      if (request.size !== undefined) {
        body['size'] = request.size
      }
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)
      })
      if (!response.ok) {
        throw classifyProviderError({ status: response.status })
      }
      const payload: unknown = await response.json()
      const items =
        typeof payload === 'object' && payload !== null && 'data' in payload
          ? (payload as { data?: unknown }).data
          : undefined
      if (!Array.isArray(items) || items.length === 0) {
        throw new ProviderEmptyResponseError()
      }
      const images: ProviderGeneratedImage[] = []
      for (const item of items.slice(0, request.count)) {
        const resolved = await resolveGeneratedImageItem(item)
        if (resolved !== null) {
          images.push(resolved)
        }
      }
      if (images.length === 0) {
        throw new ProviderEmptyResponseError()
      }
      return images
    } catch (error) {
      if (error instanceof ProviderEmptyResponseError) {
        throw error
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

/**
 * Provider-owned origins allowed for temporary image URLs (Step 5
 * §26). Only OpenAI-served hosts — never renderer/model-supplied
 * origins, never a generic download proxy.
 */
const IMAGE_URL_ALLOWED_HOSTS: readonly string[] = [
  'oaidalleapiprodscus.blob.core.windows.net',
  'oaidalleapiprodscus2.blob.core.windows.net',
  'api.openai.com'
]

function isAllowedImageUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') {
    return false
  }
  const host = url.hostname.toLowerCase()
  return IMAGE_URL_ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

function guessImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  return null
}

function decodeBase64Image(value: string): Uint8Array | null {
  let binary: string
  try {
    binary = atob(value.replace(/\s+/g, ''))
  } catch {
    return null
  }
  if (binary.length === 0 || binary.length > MAX_GENERATED_IMAGE_BYTES) {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff
  }
  return bytes
}

/**
 * Resolves one provider image item into validated bytes. Prefers
 * inline base64; provider-hosted URLs are retrieved main-side only
 * when their origin is allowlisted. Returns null for invalid items
 * (caller keeps valid siblings — partial success, no retry).
 */
async function resolveGeneratedImageItem(item: unknown): Promise<ProviderGeneratedImage | null> {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as Record<string, unknown>
  const inline = record['b64_json']
  if (typeof inline === 'string' && inline !== '') {
    const bytes = decodeBase64Image(inline)
    if (bytes === null) {
      return null
    }
    const mime = guessImageMime(bytes)
    if (mime === null) {
      return null
    }
    return { bytes, mimeType: mime }
  }
  const remote = record['url']
  if (typeof remote === 'string' && remote !== '' && isAllowedImageUrl(remote)) {
    try {
      const response = await fetch(remote, { method: 'GET', signal: AbortSignal.timeout(IMAGE_URL_FETCH_TIMEOUT_MS) })
      if (!response.ok) {
        return null
      }
      const buffer = new Uint8Array(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > MAX_GENERATED_IMAGE_BYTES) {
        return null
      }
      const mime = guessImageMime(buffer)
      if (mime === null) {
        return null
      }
      return { bytes: buffer, mimeType: mime }
    } catch {
      return null
    }
  }
  return null
}
