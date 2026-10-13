import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StarkHostedProviderAdapter, HOSTED_TRANSPORT_LIMITS } from './stark-hosted-adapter'
import {
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
import { MAX_HOSTED_IMAGE_BYTES } from '../../shared/ai/attachment-capabilities'
import {
  MAX_INFER_BODY_BYTES,
  MAX_INFER_MESSAGE_BYTES
} from '../../../supabase/functions/stark-infer/protocol'
import type { HostedSessionProvider } from '../ai/provider-adapter'

/**
 * STARK hosted adapter proof (no network, no keys, no Supabase).
 * Mock fetch captures the exact upstream request; the session
 * provider is a stub. Secret material never appears in requests
 * beyond the passed bearer, which tests supply as inert markers.
 */

interface CapturedCall {
  readonly url: string
  readonly init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
}

function mockFetch(handler: (call: CapturedCall) => Response | Promise<Response>): {
  fetchFn: typeof fetch
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const fetchFn = (async (url: string, init?: RequestInit): Promise<Response> => {
    const call: CapturedCall = {
      url,
      init: {
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
        signal: init?.signal as AbortSignal
      }
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function openAdapter(handler: (call: CapturedCall) => Response | Promise<Response>): {
  adapter: StarkHostedProviderAdapter
  calls: CapturedCall[]
} {
  const { fetchFn, calls } = mockFetch(handler)
  const session: HostedSessionProvider = {
    getAccessToken: async (): Promise<string> => 'UNUSED-BY-ADAPTER'
  }
  const adapter = new StarkHostedProviderAdapter({
    session,
    functionUrl: () => 'https://abc.supabase.co/functions/v1/stark-infer',
    fetchFn
  })
  return { adapter, calls }
}

const TEXT_OK = {
  text: 'Hello from hosted.',
  toolCalls: null,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
}

describe('hosted adapter text and structured paths', () => {
  it('sends the mapped model with the bearer and normalizes text + usage', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    const result = await adapter.generateText({
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gpt-5.6-luna',
      instructions: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 512
    })
    assert.equal(result.text, 'Hello from hosted.')
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://abc.supabase.co/functions/v1/stark-infer')
    assert.equal(calls[0]?.init.headers?.['Authorization'], 'Bearer ACCESS-MARKER')
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    assert.equal(body['model'], 'builtin:gpt-5.6-luna')
    assert.ok(!JSON.stringify(body).includes('openai/gpt-5.6-luna'), 'desktop must not send upstream ids')
    assert.ok(!JSON.stringify(body).includes('OPENROUTER'), 'no provider internals leak into the request')
  })

  it('dash transcription resolves to the same route', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await adapter.generateText({
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gpt-5-6-luna',
      instructions: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 512
    })
    assert.equal(calls.length, 1)
  })

  it('rejects unknown builtin ids before any network call', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await assert.rejects(
      adapter.generateText({
        apiKey: 'ACCESS-MARKER',
        model: 'builtin:evil-model',
        instructions: 'Be brief.',
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 512
      }),
      ProviderModelUnavailableError
    )
    assert.equal(calls.length, 0)
  })

  it('sends structured format only for capable models', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, { ...TEXT_OK, text: '{"a":1}' }))
    const result = await adapter.generateStructured({
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gpt-5.6-luna',
      instructions: 'Return JSON.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 512,
      schemaName: 's',
      schema: { type: 'object' }
    })
    assert.equal(result.outputText, '{"a":1}')
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    assert.deepEqual(body['responseFormat'], { name: 's', schema: { type: 'object' } })
  })

  it('refuses structured output for LongCat without network', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await assert.rejects(
      adapter.generateStructured({
        apiKey: 'ACCESS-MARKER',
        model: 'builtin:longcat-2.0',
        instructions: 'Return JSON.',
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 512,
        schemaName: 's',
        schema: { type: 'object' }
      }),
      ProviderStructuredOutputUnsupportedError
    )
    assert.equal(calls.length, 0)
  })

  it('omits reasoning effort where the route lacks support', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await adapter.generateText({
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gemini-2.5-flash',
      instructions: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 512,
      reasoningEffort: 'high'
    })
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    assert.ok(!('reasoningEffort' in body), 'unsupported effort must be omitted, never forwarded')
  })

  it('lists the static Free catalog with no network', async () => {
    const { adapter, calls } = openAdapter(() => {
      throw new Error('must not call network')
    })
    const models = await adapter.listModels('anything')
    assert.equal(models.length, 15)
    assert.ok(models.every((entry) => entry.id.startsWith('builtin:')))
    assert.equal(calls.length, 0)
  })
})

describe('hosted adapter worker turns', () => {
  function turnRequest() {
    return {
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gpt-5.6-luna',
      instructions: 'Do work.',
      messages: [{ role: 'user' as const, content: 'Do it.' }],
      maxOutputTokens: 512,
      tools: [{ name: 'workspace_read', description: 'Read a file.', parameters: { type: 'object' } }]
    }
  }

  it('normalizes exactly one tool call', async () => {
    const { adapter, calls } = openAdapter(() =>
      jsonResponse(200, {
        text: null,
        toolCalls: [{ id: 'call_1', name: 'workspace_read', args: { path: 'a.ts' } }],
        usage: null
      })
    )
    const result = await adapter.generateWorkerTurn(turnRequest())
    assert.equal(result.kind, 'tool_request')
    if (result.kind === 'tool_request') {
      assert.equal(result.tool, 'workspace_read')
      assert.deepEqual(result.args, { path: 'a.ts' })
    }
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    assert.ok(Array.isArray(body['tools']), 'advertised tools must travel with the turn')
  })

  it('normalizes final text', async () => {
    const { adapter } = openAdapter(() => jsonResponse(200, TEXT_OK))
    const result = await adapter.generateWorkerTurn(turnRequest())
    assert.equal(result.kind, 'final_text')
  })

  it('rejects multiple tool calls and empty turns', async () => {
    const { adapter } = openAdapter(() =>
      jsonResponse(200, {
        text: null,
        toolCalls: [
          { id: 'a', name: 'workspace_read', args: {} },
          { id: 'b', name: 'workspace_read', args: {} }
        ],
        usage: null
      })
    )
    await assert.rejects(adapter.generateWorkerTurn(turnRequest()), ProviderGenericError)
    const empty = openAdapter(() => jsonResponse(200, { text: null, toolCalls: null, usage: null }))
    await assert.rejects(empty.adapter.generateWorkerTurn(turnRequest()), ProviderEmptyResponseError)
  })
})

describe('hosted adapter failure mapping', () => {
  function textRequest() {
    return {
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gpt-5.6-luna',
      instructions: 'Be brief.',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      maxOutputTokens: 512
    }
  }

  it('maps edge codes to safe errors', async () => {
    const signIn = openAdapter(() => jsonResponse(401, { error: { code: 'sign_in_required' } }))
    await assert.rejects(signIn.adapter.generateText(textRequest()), StarkHostedSignInRequiredError)
    const limited = openAdapter(() => jsonResponse(429, { error: { code: 'hosted_capacity_limited' } }))
    await assert.rejects(limited.adapter.generateText(textRequest()), ProviderRateLimitedError)
    const rateLimited = openAdapter(() => jsonResponse(429, { error: { code: 'hosted_rate_limited' } }))
    await assert.rejects(rateLimited.adapter.generateText(textRequest()), ProviderRateLimitedError)
    const down = openAdapter(() => jsonResponse(502, { error: { code: 'hosted_service_unavailable' } }))
    await assert.rejects(down.adapter.generateText(textRequest()), StarkHostedUnavailableError)
    const malformed = openAdapter(() => jsonResponse(200, { nope: true }))
    await assert.rejects(malformed.adapter.generateText(textRequest()), StarkHostedUnavailableError)
  })

  it('maps timeouts and transport failures without leaking', async () => {
    const timeout = openAdapter(() => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    })
    await assert.rejects(timeout.adapter.generateText(textRequest()), ProviderTimeoutError)
    const network = openAdapter(() => {
      throw new TypeError('fetch failed')
    })
    await assert.rejects(network.adapter.generateText(textRequest()), StarkHostedUnavailableError)
  })

  it('fails closed without a configured function URL', async () => {
    const adapter = new StarkHostedProviderAdapter({
      session: { getAccessToken: async () => 'ACCESS-MARKER' },
      functionUrl: () => null,
      fetchFn: (async () => {
        throw new Error('must not call network')
      }) as unknown as typeof fetch
    })
    await assert.rejects(
      adapter.generateText({
        apiKey: 'ACCESS-MARKER',
        model: 'builtin:gpt-5.6-luna',
        instructions: 'Be brief.',
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 512
      }),
      StarkHostedUnavailableError
    )
  })
})

describe('hosted adapter transport preflight', () => {
  function imageAttachment(rawBytes: number) {
    return {
      kind: 'image' as const,
      id: 'a'.repeat(32),
      name: 'hero.png',
      mimeType: 'image/png',
      base64: 'A'.repeat(Math.ceil(rawBytes / 3) * 4)
    }
  }

  function imageRequest(rawBytes: number) {
    return {
      apiKey: 'ACCESS-MARKER',
      model: 'builtin:gpt-5.6-luna',
      instructions: 'Describe.',
      messages: [{ role: 'user' as const, content: '[ATTACHMENTS 1]\n[ATTACHMENT 1] id: a name: hero.png Image' }],
      maxOutputTokens: 512,
      attachments: [imageAttachment(rawBytes)]
    }
  }

  it('mirrors the edge protocol bounds (parity, not drift)', () => {
    assert.equal(HOSTED_TRANSPORT_LIMITS.bodyBytes, MAX_INFER_BODY_BYTES)
    assert.equal(HOSTED_TRANSPORT_LIMITS.messageBytes, MAX_INFER_MESSAGE_BYTES)
  })

  it('sends a very small image without preflight interference', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    const result = await adapter.generateText(imageRequest(10 * 1024))
    assert.equal(result.text, 'Hello from hosted.')
    assert.equal(calls.length, 1)
  })

  it('sends a near-threshold image that still fits one message', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await adapter.generateText(imageRequest(MAX_HOSTED_IMAGE_BYTES))
    assert.equal(calls.length, 1)
  })

  it('measures the exact hosted boundary wire bytes (adapter guards protocol truth, plan guards the 96 KiB gate)', async () => {
    // boundary - 1 and boundary → send; assert the actual serialized wire bytes stay under both caps.
    for (const raw of [MAX_HOSTED_IMAGE_BYTES - 1, MAX_HOSTED_IMAGE_BYTES]) {
      const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
      await adapter.generateText(imageRequest(raw))
      assert.equal(calls.length, 1, `${String(raw)} must send at the adapter (protocol truth)`)
      const wire = Buffer.byteLength(calls[0]?.init.body ?? '', 'utf8')
      assert.ok(wire < MAX_INFER_MESSAGE_BYTES, `wire ${String(wire)} must fit one message`)
      assert.ok(wire < MAX_INFER_BODY_BYTES, `wire ${String(wire)} must fit the body`)
    }
    // boundary + 1 and 100 KiB still fit the 160 KiB wire alone, so the
    // adapter (protocol truth) sends them — the CONSERVATIVE 96 KiB
    // per-image gate lives earlier in planAiAttachments and rejects them
    // there (safety beats the example; see the plan-level boundary suite).
    // The adapter backstop rejects only true protocol overflow (e.g. 200 KiB raw).
    for (const raw of [MAX_HOSTED_IMAGE_BYTES + 1, 100 * 1024]) {
      const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
      await adapter.generateText(imageRequest(raw))
      assert.equal(calls.length, 1, `${String(raw)} fits the wire alone so the adapter sends; plan rejects it earlier`)
    }
  })

  it('small text plus a boundary image sends; larger text plus the same image overflows the message backstop', async () => {
    const base = imageRequest(MAX_HOSTED_IMAGE_BYTES)
    // Small text: review + 1 KiB still fits.
    {
      const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
      await adapter.generateText({ ...base, messages: [{ role: 'user' as const, content: `[ATTACHMENTS 1]\n${'t'.repeat(1024)}` }] })
      assert.equal(calls.length, 1)
    }
    // Larger text: the same image plus ~32 KiB text overflows one 160 KiB message → backstop rejects.
    {
      const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
      await assert.rejects(
        adapter.generateText({ ...base, messages: [{ role: 'user' as const, content: `[ATTACHMENTS 1]\n${'t'.repeat(32 * 1024)}` }] }),
        ImageTooLargeForHostedTransportError
      )
      assert.equal(calls.length, 0)
    }
  })

  it('multiple boundary images overflow one message even though each fits alone (backstop, not silent truncation)', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    const one = imageAttachment(64 * 1024)
    const two = { ...one, id: 'b'.repeat(32), name: 'b.png' }
    await assert.rejects(
      adapter.generateText({
        apiKey: 'ACCESS-MARKER',
        model: 'builtin:gpt-5.6-luna',
        instructions: 'Describe.',
        messages: [{ role: 'user' as const, content: '[ATTACHMENTS 2]' }],
        maxOutputTokens: 512,
        attachments: [one, two]
      }),
      ImageTooLargeForHostedTransportError
    )
    assert.equal(calls.length, 0)
  })

  it('rejects an over-threshold image before any network call', async () => {
    // 200 KiB raw encodes to ~267 KiB on the wire: over the 160 KiB
    // edge message cap. (The 96 KiB plan-level threshold is enforced
    // earlier in planAiAttachments; the adapter guards protocol truth.)
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await assert.rejects(adapter.generateText(imageRequest(200 * 1024)), ImageTooLargeForHostedTransportError)
    assert.equal(calls.length, 0, 'doomed request must never reach the network')
  })

  it('rejects a desktop-maximum image before any network call', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    await assert.rejects(adapter.generateText(imageRequest(5 * 1024 * 1024)), ImageTooLargeForHostedTransportError)
    assert.equal(calls.length, 0)
  })

  it('rejects an aggregate body over the total limit even when each message fits', async () => {
    const { adapter, calls } = openAdapter(() => jsonResponse(200, TEXT_OK))
    const big = 'x'.repeat(130 * 1024)
    await assert.rejects(
      adapter.generateText({
        apiKey: 'ACCESS-MARKER',
        model: 'builtin:gpt-5.6-luna',
        instructions: 'Be brief.',
        messages: [
          { role: 'user' as const, content: big },
          { role: 'user' as const, content: big },
          { role: 'user' as const, content: big }
        ],
        maxOutputTokens: 512
      }),
      ImageTooLargeForHostedTransportError
    )
    assert.equal(calls.length, 0)
  })

  it('keeps the transport error user-safe with no protocol internals', async () => {
    const { adapter } = openAdapter(() => jsonResponse(200, TEXT_OK))
    const error = await adapter.generateText(imageRequest(200 * 1024)).then(
      () => null,
      (caught: unknown) => caught
    )
    assert.ok(error instanceof ImageTooLargeForHostedTransportError)
    assert.equal(
      (error as Error).message,
      'This image is too large to send with STARK Free. Use a smaller image or a connected provider.'
    )
  })
})
