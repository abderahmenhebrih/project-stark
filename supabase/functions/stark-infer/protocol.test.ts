import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  HOSTED_MODEL_COUNT,
  HOSTED_MODEL_ROUTES,
  resolveHostedRoute
} from './model-map'
import {
  MAX_INFER_BODY_BYTES,
  MAX_INFER_MESSAGES,
  MAX_INFER_OUTPUT_TOKENS,
  mapUpstreamStatus,
  normalizeUpstreamResponse,
  validateInferRequest
} from './protocol'

/**
 * stark-infer protocol proof (no Deno runtime, no network, no keys).
 * Model allowlist, request validation, upstream normalization, and
 * error mapping run directly; the Deno entrypoint (auth gate,
 * secret handling) is asserted structurally — fetching it would
 * require live Supabase/OpenRouter.
 */

function validBody(): Record<string, unknown> {
  return {
    model: 'builtin:gpt-5.6-luna',
    instructions: 'Be brief.',
    messages: [{ role: 'user', content: 'Say OK.' }],
    maxTokens: 512
  }
}

describe('hosted model allowlist', () => {
  it('contains exactly the 15 STARK Free models with exact upstream ids', () => {
    assert.equal(HOSTED_MODEL_COUNT, 15)
    assert.equal(HOSTED_MODEL_ROUTES.length, 15)
    assert.deepEqual(
      HOSTED_MODEL_ROUTES.map((entry) => entry.builtinId),
      [
        'builtin:muse-spark-1.3',
        'builtin:glm-5.3-flash',
        'builtin:deepseek-v4.1-flash',
        'builtin:gpt-5.6-luna',
        'builtin:gemini-2.5-flash',
        'builtin:claude-haiku-5.5',
        'builtin:minimax-m3',
        'builtin:kimi-k2.7-code',
        'builtin:mimo-v2.6-pro',
        'builtin:mimo-v2.6-flash',
        'builtin:nemotron-3.5-lightning',
        'builtin:deepseek-v4-flash',
        'builtin:muse-spark-1.2',
        'builtin:longcat-2.0',
        'builtin:mistral-large-4'
      ]
    )
    const upstream = new Map(HOSTED_MODEL_ROUTES.map((entry) => [entry.builtinId, entry.openRouterId]))
    assert.equal(upstream.get('builtin:gpt-5.6-luna'), 'openai/gpt-5.6-luna')
    assert.equal(upstream.get('builtin:longcat-2.0'), 'meituan/longcat-2.0')
    assert.equal(upstream.get('builtin:mistral-large-4'), 'mistralai/mistral-large-4-0')
    assert.equal(upstream.get('builtin:mimo-v2.6-pro'), 'xiaomi/mimo-v2.6-pro')
    assert.equal(upstream.get('builtin:kimi-k2.7-code'), 'moonshotai/kimi-k2.7-code')
  })

  it('accepts dot and dash transcriptions, rejects everything else', () => {
    assert.equal(resolveHostedRoute('builtin:gpt-5.6-luna')?.openRouterId, 'openai/gpt-5.6-luna')
    assert.equal(resolveHostedRoute('builtin:gpt-5-6-luna')?.openRouterId, 'openai/gpt-5.6-luna')
    assert.equal(resolveHostedRoute('builtin:muse-spark-1-3')?.openRouterId, 'meta/muse-spark-1.3')
    for (const bad of ['', 'gpt-4o', 'openai:gpt-4o', 'openai/gpt-5.6-luna', 'builtin:evil', 'builtin:gpt-5.6-luna-pro', 'builtin:']) {
      assert.equal(resolveHostedRoute(bad), null, `${bad} must not resolve`)
    }
  })

  it('carries evidence-based capability flags', () => {
    const longcat = resolveHostedRoute('builtin:longcat-2.0')
    assert.equal(longcat?.structuredOutputs, false)
    assert.equal(longcat?.reasoningEffort, false)
    assert.equal(longcat?.supportsVision, false)
    assert.equal(resolveHostedRoute('builtin:gpt-5.6-luna')?.structuredOutputs, true)
    assert.equal(resolveHostedRoute('builtin:gemini-2.5-flash')?.reasoningEffort, false)
    assert.equal(resolveHostedRoute('builtin:nemotron-3.5-lightning')?.supportsVision, false)
    assert.equal(resolveHostedRoute('builtin:deepseek-v4-flash')?.supportsVision, false)
  })
})

describe('request validation', () => {
  it('accepts a minimal valid text request', () => {
    const result = validateInferRequest({ model: 'builtin:gpt-5.6-luna', messages: [{ role: 'user', content: 'Hi' }] })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.request.route.openRouterId, 'openai/gpt-5.6-luna')
      assert.equal(result.request.maxTokens, 4096)
      assert.equal(result.request.reasoningEffort, null)
      assert.equal(result.request.responseFormat, null)
      assert.equal(result.request.tools, null)
    }
  })

  it('accepts structured and worker-turn requests with capability gating', () => {
    const structured = validateInferRequest({
      ...validBody(),
      responseFormat: { name: 'plan', schema: { type: 'object' } },
      reasoningEffort: 'medium'
    })
    assert.equal(structured.ok, true)
    if (structured.ok) {
      assert.equal(structured.request.reasoningEffort, 'medium')
      assert.equal(structured.request.responseFormat?.name, 'plan')
    }
    // Unsupported reasoning effort is omitted, never forwarded blindly.
    const noEffort = validateInferRequest({ ...validBody(), model: 'builtin:gemini-2.5-flash', reasoningEffort: 'high' })
    assert.equal(noEffort.ok, true)
    if (noEffort.ok) {
      assert.equal(noEffort.request.reasoningEffort, null)
    }
    // Structured output on LongCat is rejected before any upstream call.
    const longcatStructured = validateInferRequest({
      model: 'builtin:longcat-2.0',
      messages: [{ role: 'user', content: 'Hi' }],
      responseFormat: { name: 'plan', schema: { type: 'object' } }
    })
    assert.equal(longcatStructured.ok, false)
    if (!longcatStructured.ok) {
      assert.equal(longcatStructured.code, 'unsupported_model')
    }
    const workerTurn = validateInferRequest({
      ...validBody(),
      tools: [{ name: 'workspace_read', description: 'Read a file.', parameters: { type: 'object' } }]
    })
    assert.equal(workerTurn.ok, true)
  })

  it('rejects unknown models so the endpoint is never an open proxy', () => {
    for (const model of ['openai/gpt-4o', 'gpt-4o', 'builtin:nope', 'builtin:gpt-5.6-luna-pro']) {
      const result = validateInferRequest({ model, messages: [{ role: 'user', content: 'Hi' }] })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.code, 'unsupported_model')
      }
    }
    const empty = validateInferRequest({ model: '', messages: [{ role: 'user', content: 'Hi' }] })
    assert.equal(empty.ok, false)
  })

  it('enforces structural and size bounds', () => {
    assert.equal(validateInferRequest(null).ok, false)
    assert.equal(validateInferRequest({ model: 'builtin:gpt-5.6-luna', messages: [] }).ok, false)
    const tooMany = {
      model: 'builtin:gpt-5.6-luna',
      messages: Array.from({ length: MAX_INFER_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }))
    }
    assert.equal(validateInferRequest(tooMany).ok, false)
    assert.equal(
      validateInferRequest({ model: 'builtin:gpt-5.6-luna', messages: [{ role: 'user', content: 'x'.repeat(200 * 1024) }] }).ok,
      false
    )
    assert.equal(
      validateInferRequest({ ...validBody(), maxTokens: MAX_INFER_OUTPUT_TOKENS + 1 }).ok,
      true
    )
    const capped = validateInferRequest({ ...validBody(), maxTokens: MAX_INFER_OUTPUT_TOKENS + 1 })
    if (capped.ok) {
      assert.equal(capped.request.maxTokens, MAX_INFER_OUTPUT_TOKENS)
    }
    assert.equal(validateInferRequest({ ...validBody(), reasoningEffort: 'ultra' }).ok, false)
    assert.equal(
      validateInferRequest({ ...validBody(), tools: [{ name: 'a', description: 'b' }, { name: 'a', description: 'c' }] }).ok,
      false
    )
    assert.equal(
      validateInferRequest({ ...validBody(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.example/x.png' } }] }] }).ok,
      false
    )
    assert.ok(MAX_INFER_BODY_BYTES >= 128 * 1024, 'body cap must cover bounded contexts')
  })
})

describe('upstream normalization', () => {
  it('normalizes text, tool calls, and usage while dropping cost', () => {
    const result = normalizeUpstreamResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Done.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'workspace_read', arguments: '{"path":"a"}' } }]
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }
    })
    assert.ok(result !== null)
    assert.equal(result?.text, 'Done.')
    assert.deepEqual(result?.toolCalls, [{ id: 'call_1', name: 'workspace_read', args: { path: 'a' } }])
    assert.deepEqual(result?.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    assert.ok(!JSON.stringify(result).includes('cost'), 'cost must never cross the boundary')
  })

  it('rejects malformed and empty upstream responses', () => {
    for (const bad of [
      null,
      {},
      { choices: [] },
      { choices: [{ message: { role: 'assistant', content: '' } }] },
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [] } }] },
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', function: { name: '', arguments: '{}' } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'x', tool_calls: 'nope' } }] }
    ]) {
      assert.equal(normalizeUpstreamResponse(bad), null, 'malformed upstream must normalize to null')
    }
  })

  it('maps upstream statuses without leaking bodies', () => {
    assert.equal(mapUpstreamStatus(429), 'hosted_rate_limited')
    for (const status of [502, 503, 529]) {
      assert.equal(mapUpstreamStatus(status), 'hosted_capacity_limited')
    }
    for (const status of [400, 401, 403, 404, 500]) {
      assert.equal(mapUpstreamStatus(status), 'hosted_service_unavailable')
    }
  })

  it('routes non-ok upstream responses through the single status mapping', () => {
    const file = join(process.cwd(), 'supabase', 'functions', 'stark-infer', 'index.ts')
    assert.ok(existsSync(file), 'edge entrypoint must exist')
    const source = readFileSync(file, 'utf8')
    assert.ok(source.includes('mapUpstreamStatus(upstream.status)'), 'entrypoint must use the single mapping')
    assert.ok(!source.includes("errorResponse(429, 'hosted_capacity_limited')"), 'ad-hoc 429 mapping must be gone')
  })
})

describe('entrypoint hygiene (structural)', () => {
  function entrypoint(): string {
    const file = join(process.cwd(), 'supabase', 'functions', 'stark-infer', 'index.ts')
    assert.ok(existsSync(file), 'edge entrypoint must exist')
    return readFileSync(file, 'utf8')
  }

  it('gates on a verified Supabase identity with no anonymous path', () => {
    const source = entrypoint()
    assert.ok(source.includes('getUser'), 'entrypoint must verify the JWT via getUser')
    assert.ok(source.includes('sign_in_required'), 'auth failures must map to sign_in_required')
    assert.ok(!source.includes('service_role'), 'entrypoint must not name service roles')
  })

  it('reads the OpenRouter credential only from the function secret', () => {
    const source = entrypoint()
    assert.ok(source.includes("Deno.env.get('OPENROUTER_API_KEY')"), 'key must come from the function secret')
    assert.ok(!source.includes('sk-or-'), 'no key material may be embedded')
    for (const forbidden of ['console.log(JSON', 'console.log(body', 'console.log(raw', 'console.log(token']) {
      assert.ok(!source.includes(forbidden), `entrypoint must not log ${forbidden}`)
    }
  })
})
