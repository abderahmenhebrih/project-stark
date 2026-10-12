/**
 * stark-infer request/response protocol (pure, runtime-agnostic).
 *
 * No Deno or Node APIs — importable from the Edge Function and from
 * the desktop Node test suite alike. All bounds live here so both
 * sides of the boundary enforce the same contract.
 */

import { resolveHostedRoute, type HostedModelRoute } from './model-map'

/** Largest accepted request body (384 KiB — context plus envelope). */
export const MAX_INFER_BODY_BYTES = 384 * 1024
/** Most messages per inference request. */
export const MAX_INFER_MESSAGES = 45
/** Largest single message content (160 KiB of UTF-8). */
export const MAX_INFER_MESSAGE_BYTES = 160 * 1024
/** Largest system instruction (16 KiB of UTF-8). */
export const MAX_INFER_INSTRUCTIONS_BYTES = 16 * 1024
/** Output-token ceiling enforced server-side (matches desktop cap). */
export const MAX_INFER_OUTPUT_TOKENS = 8192
/** Default output budget when the caller sends none. */
export const DEFAULT_INFER_OUTPUT_TOKENS = 4096
/** Most tool schemas per worker-turn request. */
export const MAX_INFER_TOOLS = 32
/** Longest tool name/description (code points). */
export const MAX_INFER_TOOL_NAME_CODEPOINTS = 64
export const MAX_INFER_TOOL_DESCRIPTION_CODEPOINTS = 2000

export type InferRole = 'system' | 'developer' | 'user' | 'assistant'

export interface InferContentText {
  readonly type: 'text'
  readonly text: string
}

export interface InferContentImage {
  readonly type: 'image_url'
  readonly image_url: { readonly url: string }
}

export type InferContentPart = InferContentText | InferContentImage

export interface InferMessage {
  readonly role: InferRole
  readonly content: string | readonly InferContentPart[]
}

export interface InferToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters?: unknown
}

export interface InferResponseFormat {
  readonly name: string
  readonly schema: unknown
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface InferRequest {
  readonly model: string
  readonly instructions?: string
  readonly messages: readonly InferMessage[]
  readonly maxTokens?: number
  readonly reasoningEffort?: ReasoningEffort | null
  readonly responseFormat?: InferResponseFormat | null
  readonly tools?: readonly InferToolSchema[] | null
}

export interface ValidatedInferRequest {
  readonly route: HostedModelRoute
  readonly instructions: string | null
  readonly messages: readonly InferMessage[]
  readonly maxTokens: number
  readonly reasoningEffort: ReasoningEffort | null
  readonly responseFormat: InferResponseFormat | null
  readonly tools: readonly InferToolSchema[] | null
}

/** Stable error codes returned to the desktop (never upstream bodies). */
export type InferErrorCode =
  | 'sign_in_required'
  | 'invalid_request'
  | 'unsupported_model'
  | 'payload_too_large'
  | 'hosted_rate_limited'
  | 'hosted_capacity_limited'
  | 'hosted_service_unavailable'
  | 'provider_timeout'
  | 'provider_invalid_response'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
  )
}

function validateRole(value: unknown): InferRole | null {
  if (value === 'system' || value === 'developer' || value === 'user' || value === 'assistant') {
    return value
  }
  return null
}

function validateContentPart(value: unknown): InferContentPart | null {
  if (typeof value === 'string') {
    return null
  }
  if (!isRecord(value)) {
    return null
  }
  if (value['type'] === 'text' && typeof value['text'] === 'string') {
    return { type: 'text', text: value['text'] }
  }
  if (value['type'] === 'image_url' && isRecord(value['image_url']) && typeof value['image_url']['url'] === 'string') {
    const url = value['image_url']['url'] as string
    // Data URLs only: the endpoint must never fetch arbitrary remote
    // resources with the service credential.
    if (!url.startsWith('data:image/')) {
      return null
    }
    return { type: 'image_url', image_url: { url } }
  }
  return null
}

function validateMessage(value: unknown): InferMessage | null {
  if (!isRecord(value)) {
    return null
  }
  const role = validateRole(value['role'])
  if (role === null) {
    return null
  }
  const content = value['content']
  if (typeof content === 'string') {
    if (content.includes('\0') || utf8Length(content) > MAX_INFER_MESSAGE_BYTES) {
      return null
    }
    return { role, content }
  }
  if (Array.isArray(content) && content.length > 0 && content.length <= 8) {
    const parts: InferContentPart[] = []
    for (const part of content) {
      const valid = validateContentPart(part)
      if (valid === null) {
        return null
      }
      parts.push(valid)
    }
    let bytes = 0
    for (const part of parts) {
      bytes += part.type === 'text' ? utf8Length(part.text) : utf8Length(part.image_url.url)
    }
    if (bytes > MAX_INFER_MESSAGE_BYTES) {
      return null
    }
    return { role, content: parts }
  }
  return null
}

function validateTool(value: unknown): InferToolSchema | null {
  if (!isRecord(value)) {
    return null
  }
  const name = value['name']
  const description = value['description']
  if (typeof name !== 'string' || name === '' || [...name].length > MAX_INFER_TOOL_NAME_CODEPOINTS || name.includes('\0')) {
    return null
  }
  if (
    typeof description !== 'string' ||
    description === '' ||
    [...description].length > MAX_INFER_TOOL_DESCRIPTION_CODEPOINTS ||
    description.includes('\0')
  ) {
    return null
  }
  const parameters = value['parameters']
  if (parameters !== undefined && !isRecord(parameters) && typeof parameters !== 'boolean') {
    return null
  }
  return parameters === undefined
    ? { name, description }
    : { name, description, parameters }
}

function validateResponseFormat(value: unknown): InferResponseFormat | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!isRecord(value)) {
    return null
  }
  const name = value['name']
  const schema = value['schema']
  if (typeof name !== 'string' || name === '' || [...name].length > 128 || name.includes('\0')) {
    return null
  }
  if (!isRecord(schema)) {
    return null
  }
  return { name, schema }
}

export type InferValidation =
  | { readonly ok: true; readonly request: ValidatedInferRequest }
  | { readonly ok: false; readonly code: 'invalid_request' | 'unsupported_model'; readonly detail: string }

/**
 * Validates one parsed request body. Structural failures yield
 * `invalid_request`; unknown builtin ids yield `unsupported_model`.
 * Structured requests for models without structured support are
 * rejected here (honest, before any upstream call).
 */
export function validateInferRequest(body: unknown): InferValidation {
  if (!isRecord(body)) {
    return { ok: false, code: 'invalid_request', detail: 'body must be a JSON object' }
  }
  const model = body['model']
  if (typeof model !== 'string' || model === '') {
    return { ok: false, code: 'invalid_request', detail: 'model must be a builtin id' }
  }
  const route = resolveHostedRoute(model)
  if (route === null) {
    return { ok: false, code: 'unsupported_model', detail: 'unknown builtin model' }
  }
  let instructions: string | null = null
  if (body['instructions'] !== undefined) {
    if (typeof body['instructions'] !== 'string' || body['instructions'].includes('\0')) {
      return { ok: false, code: 'invalid_request', detail: 'instructions must be text' }
    }
    if (utf8Length(body['instructions']) > MAX_INFER_INSTRUCTIONS_BYTES) {
      return { ok: false, code: 'invalid_request', detail: 'instructions too large' }
    }
    instructions = body['instructions']
  }
  const rawMessages = body['messages']
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > MAX_INFER_MESSAGES) {
    return { ok: false, code: 'invalid_request', detail: 'messages must be a non-empty bounded array' }
  }
  const messages: InferMessage[] = []
  for (const raw of rawMessages) {
    const message = validateMessage(raw)
    if (message === null) {
      return { ok: false, code: 'invalid_request', detail: 'one message is invalid or too large' }
    }
    messages.push(message)
  }
  let maxTokens = DEFAULT_INFER_OUTPUT_TOKENS
  if (body['maxTokens'] !== undefined) {
    if (typeof body['maxTokens'] !== 'number' || !Number.isInteger(body['maxTokens']) || body['maxTokens'] < 1) {
      return { ok: false, code: 'invalid_request', detail: 'maxTokens must be a positive integer' }
    }
    maxTokens = Math.min(body['maxTokens'], MAX_INFER_OUTPUT_TOKENS)
  }
  let reasoningEffort: ReasoningEffort | null = null
  if (body['reasoningEffort'] !== undefined && body['reasoningEffort'] !== null) {
    if (!isReasoningEffort(body['reasoningEffort'])) {
      return { ok: false, code: 'invalid_request', detail: 'reasoningEffort is not supported' }
    }
    // Unsupported values are omitted, never forwarded blindly.
    reasoningEffort = route.reasoningEffort ? body['reasoningEffort'] : null
  }
  const responseFormat = validateResponseFormat(body['responseFormat'] ?? null)
  if (body['responseFormat'] !== undefined && body['responseFormat'] !== null && responseFormat === null) {
    return { ok: false, code: 'invalid_request', detail: 'responseFormat is invalid' }
  }
  if (responseFormat !== null && !route.structuredOutputs) {
    return { ok: false, code: 'unsupported_model', detail: 'model does not support structured output' }
  }
  let tools: readonly InferToolSchema[] | null = null
  if (body['tools'] !== undefined && body['tools'] !== null) {
    if (!Array.isArray(body['tools']) || body['tools'].length === 0 || body['tools'].length > MAX_INFER_TOOLS) {
      return { ok: false, code: 'invalid_request', detail: 'tools must be a bounded non-empty array' }
    }
    const parsed: InferToolSchema[] = []
    for (const raw of body['tools']) {
      const tool = validateTool(raw)
      if (tool === null) {
        return { ok: false, code: 'invalid_request', detail: 'one tool schema is invalid' }
      }
      parsed.push(tool)
    }
    const names = parsed.map((tool) => tool.name)
    if (new Set(names).size !== names.length) {
      return { ok: false, code: 'invalid_request', detail: 'tool names must be unique' }
    }
    tools = parsed
  }
  return { ok: true, request: { route, instructions, messages, maxTokens, reasoningEffort, responseFormat, tools } }
}

export interface NormalizedToolCall {
  readonly id: string
  readonly name: string
  readonly args: unknown
}

export interface NormalizedInferUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

export interface NormalizedInferResult {
  readonly text: string | null
  readonly toolCalls: readonly NormalizedToolCall[] | null
  readonly usage: NormalizedInferUsage | null
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw ?? null
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * Normalizes one upstream chat-completions response into the STARK
 * provider contract: text and/or tool calls plus token usage. Cost
 * fields are dropped deliberately — billing detail never crosses
 * this boundary. Returns null for malformed responses.
 */
export function normalizeUpstreamResponse(body: unknown): NormalizedInferResult | null {
  if (!isRecord(body)) {
    return null
  }
  const choices = body['choices']
  if (!Array.isArray(choices) || choices.length === 0) {
    return null
  }
  const first = choices[0]
  if (!isRecord(first)) {
    return null
  }
  const message = first['message']
  if (!isRecord(message)) {
    return null
  }
  const content = message['content']
  const text = typeof content === 'string' && content !== '' ? content : null
  let toolCalls: readonly NormalizedToolCall[] | null = null
  const rawCalls = message['tool_calls']
  if (rawCalls !== undefined && rawCalls !== null) {
    if (!Array.isArray(rawCalls)) {
      return null
    }
    if (rawCalls.length > 8) {
      return null
    }
    const parsed: NormalizedToolCall[] = []
    for (const raw of rawCalls) {
      if (!isRecord(raw)) {
        return null
      }
      const fn = raw['function']
      if (!isRecord(fn) || typeof fn['name'] !== 'string' || fn['name'] === '') {
        return null
      }
      const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? (raw['id'] as string) : `call_${parsed.length}`
      parsed.push({ id, name: fn['name'] as string, args: parseToolArguments(fn['arguments']) })
    }
    toolCalls = parsed.length > 0 ? parsed : null
  }
  if (text === null && toolCalls === null) {
    return null
  }
  let usage: NormalizedInferUsage | null = null
  const rawUsage = body['usage']
  if (isRecord(rawUsage)) {
    const inputTokens = safeCount(rawUsage['prompt_tokens'])
    const outputTokens = safeCount(rawUsage['completion_tokens'])
    const totalTokens = safeCount(rawUsage['total_tokens'])
    if (inputTokens !== null || outputTokens !== null || totalTokens !== null) {
      usage = { inputTokens, outputTokens, totalTokens }
    }
  }
  return { text, toolCalls, usage }
}

/** Maps an upstream HTTP status to a stable desktop error code. */
export function mapUpstreamStatus(status: number): InferErrorCode {
  if (status === 429) {
    return 'hosted_capacity_limited'
  }
  if (status === 401 || status === 403) {
    return 'hosted_service_unavailable'
  }
  if (status === 404) {
    return 'hosted_service_unavailable'
  }
  if (status === 400) {
    return 'hosted_service_unavailable'
  }
  return 'hosted_service_unavailable'
}
