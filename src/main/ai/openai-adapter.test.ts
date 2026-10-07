import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AI_GENERATE_TIMEOUT_MS, PROVIDER_REQUEST_TIMEOUT_MS } from './limits'
import {
  OpenAiProviderAdapter,
  createOpenAiClient,
  type OpenAiClientFactory,
  type OpenAiClientLike
} from './openai-adapter'
import {
  ProviderEmptyResponseError,
  ProviderForbiddenError,
  ProviderGenericError,
  ProviderInvalidCredentialError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderTimeoutError
} from './errors'

interface CapturedCall {
  readonly kind: 'models' | 'responses'
  readonly params?: unknown
  readonly options?: unknown
}

function mockFactory(behavior: {
  readonly models?: unknown[] | ((options?: unknown) => unknown)
  readonly response?: unknown | ((params?: unknown, options?: unknown) => unknown)
  readonly onCall?: (call: CapturedCall) => void
}): OpenAiClientFactory {
  return (): OpenAiClientLike => ({
    models: {
      list: (options?: unknown): Promise<{ data: readonly { id: string }[] }> => {
        behavior.onCall?.({ kind: 'models', options })
        if (typeof behavior.models === 'function') {
          return Promise.resolve((behavior.models as (options?: unknown) => { data: readonly { id: string }[] })(options))
        }
        return Promise.resolve({ data: (behavior.models ?? []) as { id: string }[] })
      }
    },
    responses: {
      create: (params?: unknown, options?: unknown): Promise<{ output_text?: string }> => {
        behavior.onCall?.({ kind: 'responses', params, options })
        if (typeof behavior.response === 'function') {
          return Promise.resolve(
            (behavior.response as (params?: unknown, options?: unknown) => { output_text?: string })(params, options)
          )
        }
        return Promise.resolve((behavior.response ?? { output_text: 'hello' }) as { output_text?: string })
      }
    }
  })
}

function sdkError(status: number, extra?: Record<string, unknown>): Error {
  const error = new Error(`Request failed with status ${String(status)}`) as Error & Record<string, unknown>
  error['status'] = status
  for (const [key, value] of Object.entries(extra ?? {})) {
    error[key] = value
  }
  return error
}

/** Simulates a real SDK error class by constructor name (no SDK import). */
function namedSdkError(constructorName: string, status: number): Error {
  const error = new Error(`${constructorName}: request failed`) as Error & Record<string, unknown>
  Object.defineProperty(error, 'constructor', { value: { name: constructorName } })
  error['status'] = status
  return error
}

describe('OpenAI client environment isolation', () => {
  it('ignores poisoned OPENAI_* environment variables', () => {
    const saved = {
      OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
      OPENAI_ORG_ID: process.env['OPENAI_ORG_ID'],
      OPENAI_PROJECT_ID: process.env['OPENAI_PROJECT_ID'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY']
    } as const
    process.env['OPENAI_BASE_URL'] = 'https://example.invalid/v1'
    process.env['OPENAI_ORG_ID'] = 'org_wrong'
    process.env['OPENAI_PROJECT_ID'] = 'proj_wrong'
    process.env['OPENAI_API_KEY'] = 'wrong-environment-key'
    try {
      const client = createOpenAiClient('explicit-api-key') as unknown as Record<string, unknown>
      assert.equal(client['apiKey'], 'explicit-api-key')
      assert.equal(client['baseURL'], 'https://api.openai.com/v1')
      assert.equal(client['organization'], null)
      assert.equal(client['project'], null)
      assert.equal(client['maxRetries'], 0)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('does not mutate process.env during construction', () => {
    const before = { ...process.env }
    createOpenAiClient('explicit-api-key')
    assert.deepEqual({ ...process.env }, before)
  })
})

describe('OpenAI provider adapter', () => {
  it('uses zero retries and a bounded timeout on every call', async () => {
    const calls: CapturedCall[] = []
    const adapter = new OpenAiProviderAdapter(mockFactory({ onCall: (call) => calls.push(call) }))
    await adapter.listModels('sk-test')
    await adapter.generateText({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      instructions: 'fixed',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 4096
    })
    assert.equal(calls.length, 2)
    for (const call of calls) {
      const options = call.options as Record<string, unknown>
      assert.equal(options['maxRetries'], 0, 'SDK automatic retries must be disabled')
    }
    assert.equal((calls[0]?.options as Record<string, unknown>)['timeout'], PROVIDER_REQUEST_TIMEOUT_MS)
    assert.equal((calls[1]?.options as Record<string, unknown>)['timeout'], AI_GENERATE_TIMEOUT_MS)
  })

  it('maps, sorts, and caps the model list deterministically', async () => {
    const ids = ['zebra', 'alpha', 'middle', '', 'alpha']
    const adapter = new OpenAiProviderAdapter(mockFactory({ models: ids.map((id) => ({ id })) }))
    const models = await adapter.listModels('sk-test')
    assert.deepEqual(
      models.map((entry) => entry.id),
      ['alpha', 'alpha', 'middle', 'zebra']
    )
  })

  it('caps discovery at 500 models', async () => {
    const ids = Array.from({ length: 600 }, (_, index) => ({ id: `model-${String(index).padStart(4, '0')}` }))
    const adapter = new OpenAiProviderAdapter(mockFactory({ models: ids }))
    assert.equal((await adapter.listModels('sk-test')).length, 500)
  })

  it('sends the fixed instruction, bounded input, store:false, and no tools', async () => {
    let seen: unknown = null
    const adapter = new OpenAiProviderAdapter(
      mockFactory({
        response: (params: unknown) => {
          seen = params
          return { output_text: 'reply' }
        }
      })
    )
    await adapter.generateText({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      instructions: 'FIXED INSTRUCTIONS',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' }
      ],
      maxOutputTokens: 4096
    })
    const params = seen as Record<string, unknown>
    assert.equal(params['model'], 'gpt-4o-mini')
    assert.equal(params['instructions'], 'FIXED INSTRUCTIONS')
    assert.equal(params['store'], false)
    assert.equal(params['max_output_tokens'], 4096)
    assert.deepEqual(params['input'], [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' }
    ])
    for (const forbidden of ['tools', 'tool_choice', 'conversation', 'previous_response_id']) {
      assert.ok(!(forbidden in params), `request must not contain ${forbidden}`)
    }
  })

  it('maps output_text to the result', async () => {
    const adapter = new OpenAiProviderAdapter(mockFactory({ response: { output_text: 'real reply' } }))
    const result = await adapter.generateText({
      apiKey: 'sk-test',
      model: 'm',
      instructions: 'i',
      messages: [{ role: 'user', content: 'q' }],
      maxOutputTokens: 4096
    })
    assert.equal(result.text, 'real reply')
  })

  it('rejects empty or missing output text', async () => {
    for (const response of [{ output_text: '' }, {}]) {
      const adapter = new OpenAiProviderAdapter(mockFactory({ response }))
      await assert.rejects(
        adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 1 }),
        ProviderEmptyResponseError
      )
    }
  })

  it('classifies 401 as invalid credential without raw bodies', async () => {
    const adapter = new OpenAiProviderAdapter(
      mockFactory({
        response: () => {
          throw sdkError(401, { error: { message: 'Incorrect API key provided' } })
        }
      })
    )
    await assert.rejects(
      adapter.generateText({ apiKey: 'bad', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderInvalidCredentialError)
        assert.ok(!error.message.includes('sk-'))
        assert.ok(!error.message.includes('Incorrect API key'))
        return true
      }
    )
  })

  it('classifies 429, timeouts, network, and model errors', async () => {
    const cases: [unknown, new (...args: never[]) => Error][] = [
      [sdkError(429), ProviderRateLimitedError],
      [Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }), ProviderTimeoutError],
      [Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }), ProviderNetworkError],
      [sdkError(404), ProviderModelUnavailableError]
    ]
    for (const [failure, expected] of cases) {
      const adapter = new OpenAiProviderAdapter(
        mockFactory({
          response: () => {
            throw failure
          }
        })
      )
      await assert.rejects(
        adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 1 }),
        expected
      )
    }
  })

  it('falls back to a generic classified error for unknown failures', async () => {
    const adapter = new OpenAiProviderAdapter(
      mockFactory({
        response: () => {
          throw new Error('weird transport boom')
        }
      })
    )
    await assert.rejects(
      adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderGenericError)
        assert.ok(!String((error as Error).message).includes('weird transport boom'))
        return true
      }
    )
  })

  it('never surfaces the API key through results or errors', async () => {
    const adapter = new OpenAiProviderAdapter(mockFactory({ response: { output_text: 'ok' } }))
    const result = await adapter.generateText({
      apiKey: 'sk-super-secret',
      model: 'm',
      instructions: 'i',
      messages: [],
      maxOutputTokens: 1
    })
    assert.ok(!JSON.stringify(result).includes('sk-super-secret'))
  })

  it('diagnostic reuses one SDK call and logs only safe metadata', async () => {
    let fetchCalls = 0
    let authorization: unknown = null
    const originalFetch = globalThis.fetch
    const logged: string[] = []
    const originalLog = console.log
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls += 1
      const init = args[1] as { headers?: Record<string, unknown> } | undefined
      authorization = init?.headers?.['Authorization'] ?? null
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-diag-1' }
      })
    }) as typeof fetch
    console.log = ((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }) as typeof console.log
    try {
      const calls: CapturedCall[] = []
      const adapter = new OpenAiProviderAdapter(
        mockFactory({ models: [{ id: 'gpt-4o' }], onCall: (call) => calls.push(call) })
      )
      const diagnosis = await adapter.diagnoseConnection('sk-diag-secret')
      assert.equal(diagnosis.sameCredentialForBothPaths, true)
      assert.ok('models' in diagnosis.outcome)
      assert.equal(calls.filter((call) => call.kind === 'models').length, 1)
      assert.equal(fetchCalls, 1)
      assert.equal(authorization, 'Bearer sk-diag-secret')
      assert.equal(diagnosis.sdk.succeeded, true)
      assert.equal(diagnosis.native.succeeded, true)
      assert.equal(diagnosis.native.requestIdPresent, true)
      assert.equal(diagnosis.native.contentTypeJson, true)
      const combined = logged.join('\n')
      assert.ok(combined.includes('[STARK AI DIAGNOSTIC]'))
      assert.ok(!combined.includes('sk-diag-secret'))
      assert.ok(!combined.includes('Bearer'))
    } finally {
      globalThis.fetch = originalFetch
      console.log = originalLog
    }
  })

  it('diagnostic reports both-path failures without bodies or keys', async () => {
    const originalFetch = globalThis.fetch
    const logged: string[] = []
    const originalLog = console.log
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-diag-2' }
      })) as typeof fetch
    console.log = ((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }) as typeof console.log
    try {
      const adapter = new OpenAiProviderAdapter(
        mockFactory({
          response: undefined,
          models: (() => {
            throw sdkError(401)
          }) as unknown as { id: string }[]
        })
      )
      const diagnosis = await adapter.diagnoseConnection('sk-diag-secret')
      assert.equal(diagnosis.sdk.succeeded, false)
      assert.equal(diagnosis.sdk.status, 401)
      assert.equal(diagnosis.sdk.category, 'invalid-credential')
      assert.equal(diagnosis.native.status, 401)
      assert.ok('error' in diagnosis.outcome)
      const combined = logged.join('\n')
      assert.ok(!combined.includes('sk-diag-secret'))
    } finally {
      globalThis.fetch = originalFetch
      console.log = originalLog
    }
  })

  it('classifies the full error matrix without raw bodies', async () => {
    const cases: [unknown, new (...args: never[]) => Error][] = [
      [sdkError(401), ProviderInvalidCredentialError],
      [namedSdkError('AuthenticationError', 401), ProviderInvalidCredentialError],
      [sdkError(403), ProviderForbiddenError],
      [namedSdkError('PermissionDeniedError', 403), ProviderForbiddenError],
      [sdkError(404), ProviderModelUnavailableError],
      [namedSdkError('NotFoundError', 404), ProviderModelUnavailableError],
      [sdkError(429), ProviderRateLimitedError],
      [namedSdkError('RateLimitError', 429), ProviderRateLimitedError],
      [namedSdkError('APIConnectionTimeoutError', 0), ProviderTimeoutError],
      [namedSdkError('APIConnectionError', 0), ProviderNetworkError],
      [Object.assign(new Error('request failed'), { code: 'EAI_AGAIN' }), ProviderNetworkError],
      [new Error('mystery failure'), ProviderGenericError]
    ]
    for (const [failure, expected] of cases) {
      const adapter = new OpenAiProviderAdapter(
        mockFactory({
          response: () => {
            throw failure
          }
        })
      )
      await assert.rejects(
        adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof expected, `expected ${expected.name}`)
          assert.ok(!String((error as Error).message).includes('sk-'))
          return true
        }
      )
    }
  })

  it('never reports network, DNS, or endpoint failures as rejected keys', async () => {
    const failures: unknown[] = [
      sdkError(403),
      sdkError(404),
      Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }),
      namedSdkError('APIConnectionTimeoutError', 0)
    ]
    for (const failure of failures) {
      const adapter = new OpenAiProviderAdapter(
        mockFactory({
          response: () => {
            throw failure
          }
        })
      )
      await assert.rejects(
        adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 1 }),
        (error: unknown) => {
          assert.ok(!(error instanceof ProviderInvalidCredentialError), 'must not claim the key was rejected')
          return true
        }
      )
    }
  })
})
