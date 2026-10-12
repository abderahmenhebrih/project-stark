/**
 * stark-infer: authenticated STARK hosted inference gateway.
 *
 * Desktop (main process) → this Edge Function → OpenRouter →
 * exact mapped model. The OpenRouter credential lives ONLY in the
 * Edge Function secret `OPENROUTER_API_KEY` — it is never committed,
 * packaged, logged, returned, or sent to any client.
 *
 * Auth: Supabase `verify_jwt` (default) plus an explicit
 * `auth.getUser` check per request — missing, invalid, or expired
 * JWTs are rejected with 401 `sign_in_required`. No anonymous
 * inference. The desktop identity used is the verified JWT subject,
 * never a renderer-supplied email or id.
 *
 * Deploy: `supabase functions deploy stark-infer` after setting the
 * secret (see DEPLOY.md). No database migration; no new tables.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.79.0'
import {
  MAX_INFER_BODY_BYTES,
  normalizeUpstreamResponse,
  validateInferRequest,
  type InferErrorCode
} from './protocol.ts'

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
/** Upstream network budget: safely inside the desktop 60s budget. */
const UPSTREAM_TIMEOUT_MS = 50_000

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function errorResponse(status: number, code: InferErrorCode, detail?: string): Response {
  // Codes only — never upstream bodies, headers, or secrets. The
  // optional static detail names the failing stage, never content.
  return jsonResponse(status, detail === undefined ? { error: { code } } : { error: { code, detail } })
}

interface OpenRouterTool {
  readonly type: 'function'
  readonly function: { readonly name: string; readonly description: string; readonly parameters?: unknown }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (req.method !== 'POST') {
    return errorResponse(405, 'invalid_request', 'POST only')
  }

  // --- Authentication: verified JWT identity only. ---
  const authorization = req.headers.get('Authorization')
  if (authorization === null || !authorization.startsWith('Bearer ')) {
    return errorResponse(401, 'sign_in_required')
  }
  const token = authorization.slice('Bearer '.length).trim()
  if (token === '') {
    return errorResponse(401, 'sign_in_required')
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (supabaseUrl === '' || supabaseAnonKey === '') {
    return errorResponse(500, 'hosted_service_unavailable')
  }
  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })
    const { data, error } = await supabase.auth.getUser(token)
    if (error !== null && error !== undefined) {
      return errorResponse(401, 'sign_in_required')
    }
    if (data.user === null || data.user === undefined) {
      return errorResponse(401, 'sign_in_required')
    }
  } catch {
    return errorResponse(401, 'sign_in_required')
  }

  // --- Bounded body read. ---
  const contentLength = req.headers.get('Content-Length')
  if (contentLength !== null && Number(contentLength) > MAX_INFER_BODY_BYTES) {
    return errorResponse(413, 'payload_too_large')
  }
  let raw: string
  try {
    raw = await req.text()
  } catch {
    return errorResponse(400, 'invalid_request')
  }
  if (raw.length > MAX_INFER_BODY_BYTES) {
    return errorResponse(413, 'payload_too_large')
  }
  let body: unknown
  try {
    body = JSON.parse(raw) as unknown
  } catch {
    return errorResponse(400, 'invalid_request')
  }
  const validation = validateInferRequest(body)
  if (!validation.ok) {
    return validation.code === 'unsupported_model'
      ? errorResponse(400, 'unsupported_model')
      : errorResponse(400, 'invalid_request')
  }
  const { route, instructions, messages, maxTokens, reasoningEffort, responseFormat, tools } = validation.request

  // --- Server credential: never leaves this function. ---
  const openRouterKey = Deno.env.get('OPENROUTER_API_KEY') ?? ''
  if (openRouterKey === '') {
    return errorResponse(500, 'hosted_service_unavailable')
  }

  // --- Upstream request: mapped model only, capability-gated params. ---
  const upstreamMessages: unknown[] = []
  if (instructions !== null && instructions !== '') {
    upstreamMessages.push({ role: 'system', content: instructions })
  }
  for (const message of messages) {
    upstreamMessages.push({ role: message.role, content: message.content })
  }
  const upstreamBody: Record<string, unknown> = {
    model: route.openRouterId,
    messages: upstreamMessages,
    max_tokens: maxTokens,
    stream: false
  }
  if (reasoningEffort !== null) {
    upstreamBody['reasoning'] = { effort: reasoningEffort }
  }
  if (responseFormat !== null) {
    upstreamBody['response_format'] = {
      type: 'json_schema',
      json_schema: { name: responseFormat.name, schema: responseFormat.schema, strict: true }
    }
  }
  if (tools !== null) {
    const converted: OpenRouterTool[] = tools.map((tool) => {
      const fn: { readonly name: string; readonly description: string; readonly parameters?: unknown } =
        tool.parameters === undefined
          ? { name: tool.name, description: tool.description }
          : { name: tool.name, description: tool.description, parameters: tool.parameters }
      return { type: 'function', function: fn }
    })
    upstreamBody['tools'] = converted
    upstreamBody['tool_choice'] = 'auto'
  }

  let upstream: Response
  try {
    upstream = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'STARK'
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return errorResponse(504, 'provider_timeout')
    }
    return errorResponse(502, 'hosted_service_unavailable')
  }
  if (!upstream.ok) {
    if (upstream.status === 429) {
      return errorResponse(429, 'hosted_capacity_limited')
    }
    return errorResponse(502, 'hosted_service_unavailable')
  }
  let payload: unknown
  try {
    payload = (await upstream.json()) as unknown
  } catch {
    return errorResponse(502, 'provider_invalid_response')
  }
  const normalized = normalizeUpstreamResponse(payload)
  if (normalized === null) {
    return errorResponse(502, 'provider_invalid_response')
  }
  return jsonResponse(200, {
    text: normalized.text,
    toolCalls: normalized.toolCalls,
    usage: normalized.usage
  })
})
