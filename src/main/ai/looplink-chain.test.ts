import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GenerationInFlightError,
  InvalidProviderRequestError,
  ProviderGenericError,
  ProviderModelUnavailableError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  StarkHostedSignInRequiredError,
  StarkHostedUnavailableError
} from './errors'
import { InvalidBrainPlanError } from './ai-brain-errors'
import { VisionUnsupportedForModelError } from './ai-attachment-context'
import {
  LoopLinkBrainEmptyError,
  LoopLinkHeartEmptyError,
  auditOfOutcome,
  eligibleLoopLinkModels,
  isRetryableLoopLinkError,
  readLoopLinkChain,
  runLoopLinkChain,
  singleModelAuditFor
} from './looplink-chain'

const A = 'builtin:gpt-5.6-luna'
const B = 'builtin:claude-haiku-5.5'
const C = 'builtin:deepseek-v4.1-flash'

describe('looplink failure classification', () => {
  it('fails over only for retryable model/runtime failures', () => {
    for (const retryable of [
      new ProviderTimeoutError(),
      new ProviderRateLimitedError(),
      new StarkHostedUnavailableError(),
      new ProviderModelUnavailableError(),
      new VisionUnsupportedForModelError(),
      new InvalidBrainPlanError()
    ]) {
      assert.equal(isRetryableLoopLinkError(retryable), true, retryable.name)
    }
    for (const fatal of [
      new StarkHostedSignInRequiredError(),
      new GenerationInFlightError(),
      new InvalidProviderRequestError('x'),
      { cancelled: true },
      { name: 'AbortError', message: 'cancelled' }
    ]) {
      assert.equal(isRetryableLoopLinkError(fatal), false)
    }
  })

  it('generic failures fail over only with transient cause evidence', () => {
    // Bare generics (no cause, e.g. upstream shape violations) fail closed.
    assert.equal(isRetryableLoopLinkError(new ProviderGenericError()), false)
    // Non-transient causes fail closed: auth shapes, 4xx, unknown shapes.
    for (const cause of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 400 }, { model: 'x' }, 'mystery']) {
      assert.equal(isRetryableLoopLinkError(new ProviderGenericError({ cause })), false, JSON.stringify(cause))
    }
    // Transient evidence still fails over: 5xx, 429/408, timeout/network markers.
    for (const cause of [
      { status: 500 },
      { status: 502 },
      { status: 429 },
      { status: 408 },
      { code: 'ETIMEDOUT' },
      { code: 'ENOTFOUND' },
      new Error('request timed out'),
      new Error('fetch failed'),
      { name: 'APIConnectionError' }
    ]) {
      assert.equal(isRetryableLoopLinkError(new ProviderGenericError({ cause })), true, JSON.stringify(cause))
    }
  })

  it('generic without transient cause never burns the chain', async () => {
    const called: string[] = []
    await assert.rejects(
      runLoopLinkChain([A, B], async (modelId) => {
        called.push(modelId)
        throw new ProviderGenericError()
      }),
      (error: unknown) => error instanceof ProviderGenericError
    )
    assert.deepEqual(called, [A])
  })

  it('generic with a 5xx cause still fails over', async () => {
    const called: string[] = []
    const outcome = await runLoopLinkChain([A, B], async (modelId) => {
      called.push(modelId)
      if (modelId === A) {
        throw new ProviderGenericError({ cause: { status: 503 } })
      }
      return 'b-ok'
    })
    assert.deepEqual(called, [A, B])
    assert.equal(outcome.modelId, B)
  })
})

describe('looplink bounded failover', () => {
  it('first success short-circuits (only A called)', async () => {
    const called: string[] = []
    const outcome = await runLoopLinkChain([A, B, C], async (modelId) => {
      called.push(modelId)
      return `ok:${modelId}`
    })
    assert.deepEqual(called, [A])
    assert.equal(outcome.modelId, A)
    assert.equal(outcome.attempts, 1)
    assert.equal(outcome.failoverNote, null)
    assert.deepEqual([...outcome.attemptedModelIds], [A])
  })

  it('retryable failure advances in UI order (A->B)', async () => {
    const called: string[] = []
    const outcome = await runLoopLinkChain([A, B, C], async (modelId) => {
      called.push(modelId)
      if (modelId === A) {
        throw new ProviderTimeoutError()
      }
      return 'b-ok'
    })
    assert.deepEqual(called, [A, B])
    assert.equal(outcome.modelId, B)
    assert.equal(outcome.attempts, 2)
    assert.deepEqual([...outcome.attemptedModelIds], [A, B])
    assert.ok(outcome.failoverNote !== null && outcome.failoverNote.includes(B))
  })

  it('A+B fail -> C called', async () => {
    const called: string[] = []
    const outcome = await runLoopLinkChain([A, B, C], async (modelId) => {
      called.push(modelId)
      if (modelId !== C) {
        throw new StarkHostedUnavailableError()
      }
      return 'c-ok'
    })
    assert.deepEqual(called, [A, B, C])
    assert.equal(outcome.modelId, C)
    assert.equal(outcome.attempts, 3)
    assert.deepEqual([...outcome.attemptedModelIds], [A, B, C])
  })

  it('reorder changes the first model used', async () => {
    const first = await runLoopLinkChain([A, B], async () => 'ok')
    const reordered = await runLoopLinkChain([B, A], async () => 'ok')
    assert.equal(first.modelId, A)
    assert.equal(reordered.modelId, B)
  })

  it('non-retryable failure never fails over', async () => {
    const called: string[] = []
    await assert.rejects(
      runLoopLinkChain([A, B], async (modelId) => {
        called.push(modelId)
        throw new StarkHostedSignInRequiredError()
      }),
      (error: unknown) => error instanceof StarkHostedSignInRequiredError
    )
    assert.deepEqual(called, [A])
  })

  it('cancellation stops immediately', async () => {
    const called: string[] = []
    await assert.rejects(
      runLoopLinkChain([A, B], async (modelId) => {
        called.push(modelId)
        throw new ProviderTimeoutError()
      }, { isCancelled: () => true }),
      (error: unknown) => error instanceof Error
    )
    assert.deepEqual(called, [])
  })

  it('all models fail -> bounded final error (last)', async () => {
    const first = new ProviderTimeoutError()
    const last = new ProviderRateLimitedError()
    await assert.rejects(
      runLoopLinkChain([A, B], async (modelId) => {
        throw modelId === A ? first : last
      }),
      (error: unknown) => error === last
    )
  })

  it('caps at 5 models', async () => {
    const chain = [A, B, C, 'builtin:gemini-2.5-flash', 'builtin:mimo-v2.6-pro', 'builtin:mistral-large-4']
    const called: string[] = []
    await assert.rejects(
      runLoopLinkChain(chain, async (modelId) => {
        called.push(modelId)
        throw new ProviderTimeoutError()
      })
    )
    assert.equal(called.length, 5)
  })
})

describe('looplink chain IPC validation', () => {
  it('absent means legacy (null)', () => {
    assert.equal(readLoopLinkChain({}, 'brainModels', 'brain'), null)
    assert.equal(readLoopLinkChain({ brainModels: undefined }, 'brainModels', 'brain'), null)
  })

  it('empty brain chain fails with looplink_brain_empty', () => {
    assert.throws(() => readLoopLinkChain({ brainModels: [] }, 'brainModels', 'brain'), (error: unknown) => {
      return error instanceof LoopLinkBrainEmptyError && (error as Error).message === 'looplink_brain_empty'
    })
  })

  it('empty heart chain fails with looplink_heart_empty', () => {
    assert.throws(() => readLoopLinkChain({ heartModels: [] }, 'heartModels', 'heart'), (error: unknown) => {
      return error instanceof LoopLinkHeartEmptyError && (error as Error).message === 'looplink_heart_empty'
    })
  })

  it('unknown ids and duplicates rejected', () => {
    assert.throws(() => readLoopLinkChain({ brainModels: ['builtin:nope'] }, 'brainModels', 'brain'))
    assert.throws(() => readLoopLinkChain({ brainModels: [A, A] }, 'brainModels', 'brain'))
    assert.throws(() => readLoopLinkChain({ brainModels: [A, B, C, A, B, C] }, 'brainModels', 'brain'))
    assert.throws(() =>
      readLoopLinkChain({ brainModels: ['openai/gpt-5.6-luna'] }, 'brainModels', 'brain')
    )
  })

  it('eligible filtering preserves order for phases', () => {
    const eligible = eligibleLoopLinkModels(['builtin:longcat-2.0', A], { needsStructured: true, needsVision: false })
    assert.deepEqual([...eligible], [A])
  })

  it('main authority ignores renderer disabled lists (legacy tolerance, never trusted)', () => {
    // Genuinely executable models pass regardless of disabled-list forgery.
    assert.deepEqual(readLoopLinkChain({ brainModels: [A, B] }, 'brainModels', 'brain'), [A, B])
    assert.deepEqual(
      readLoopLinkChain({ brainModels: [A, B], disabledBrainModels: [C] }, 'brainModels', 'brain', 'disabledBrainModels'),
      [A, B]
    )
    // 1. omits disabled list completely → still validated by main authority.
    assert.deepEqual(readLoopLinkChain({ brainModels: [A] }, 'brainModels', 'brain', 'disabledBrainModels'), [A])
    // 2. sends [] → same outcome (disabled lists never decide).
    assert.deepEqual(
      readLoopLinkChain({ brainModels: [A], disabledBrainModels: [] }, 'brainModels', 'brain', 'disabledBrainModels'),
      [A]
    )
    // 3. falsely reports an enabled model as disabled → IGNORED, chain still passes.
    assert.deepEqual(
      readLoopLinkChain({ brainModels: [A], disabledBrainModels: [A] }, 'brainModels', 'brain', 'disabledBrainModels'),
      [A]
    )
    // 4. sends a stale roster → IGNORED, chain still passes.
    assert.deepEqual(
      readLoopLinkChain(
        { brainModels: [A], disabledBrainModels: [B, C, 'builtin:unknown-x'] },
        'brainModels',
        'brain',
        'disabledBrainModels'
      ),
      [A]
    )
    // Malformed disabled values are tolerated (ignored), never authoritative.
    for (const bad of ['x', 7, [7], [''], [A, 7], new Array(1025).fill(A)]) {
      assert.deepEqual(
        readLoopLinkChain({ brainModels: [A], disabledBrainModels: bad }, 'brainModels', 'brain', 'disabledBrainModels'),
        [A]
      )
    }
  })

  it('forged chains fail closed on main executability (not on renderer lists)', () => {
    // 5. unknown model → rejected (never an open proxy).
    assert.throws(
      () => readLoopLinkChain({ brainModels: ['builtin:unknown-x'] }, 'brainModels', 'brain', 'disabledBrainModels'),
      ProviderModelUnavailableError
    )
    // 6. administratively disabled known-syntax model (incompatible BYOK family) → rejected
    // even when the renderer omits, empties, or falsifies the disabled list.
    for (const forged of [
      { brainModels: ['openai:whisper-1'] },
      { brainModels: ['openai:whisper-1'], disabledBrainModels: [] },
      { brainModels: ['openai:whisper-1'], disabledBrainModels: [A] },
      { brainModels: [A, 'openai:text-embedding-3-small'] },
      { brainModels: ['openai:dall-e-3'], disabledBrainModels: ['builtin:unknown-x'] }
    ]) {
      assert.throws(
        () => readLoopLinkChain(forged, 'brainModels', 'brain', 'disabledBrainModels'),
        ProviderModelUnavailableError,
        JSON.stringify(forged)
      )
    }
    // 7. valid enabled models pass (the only passing class).
    assert.deepEqual(readLoopLinkChain({ brainModels: [A] }, 'brainModels', 'brain', 'disabledBrainModels'), [A])
    assert.deepEqual(
      readLoopLinkChain({ brainModels: [A, 'openai:gpt-4o'] }, 'brainModels', 'brain', 'disabledBrainModels'),
      [A, 'openai:gpt-4o']
    )
  })

  it('chain eligibility does not depend on renderer-provided disabled arrays (architecture)', () => {
    const chain = { brainModels: [A, B] }
    const variants: readonly Record<string, unknown>[] = [
      chain,
      { ...chain, disabledBrainModels: [] },
      { ...chain, disabledBrainModels: [C] },
      { ...chain, disabledBrainModels: [A] },
      { ...chain, disabledBrainModels: 'garbage' },
      { ...chain, disabledBrainModels: new Array(1025).fill(A) }
    ]
    for (const variant of variants) {
      assert.deepEqual(readLoopLinkChain(variant, 'brainModels', 'brain', 'disabledBrainModels'), [A, B])
    }
    // Disabled-class entries fail identically across all disabled-list forgeries.
    const badVariants: readonly Record<string, unknown>[] = [
      { brainModels: ['openai:whisper-1'] },
      { brainModels: ['openai:whisper-1'], disabledBrainModels: [] },
      { brainModels: ['openai:whisper-1'], disabledBrainModels: [A, B, C] }
    ]
    for (const variant of badVariants) {
      assert.throws(
        () => readLoopLinkChain(variant, 'brainModels', 'brain', 'disabledBrainModels'),
        ProviderModelUnavailableError
      )
    }
  })

  it('audit helpers preserve attempt truth without secrets', () => {
    const audit = auditOfOutcome({ attempts: 2, failoverNote: 'Switched to b.', attemptedModelIds: [A, B] }, [A, B, C])
    assert.equal(audit.attempts, 2)
    assert.equal(audit.failoverNote, 'Switched to b.')
    assert.deepEqual([...audit.attemptedModels], [A, B])
    assert.deepEqual([...audit.requestedChain], [A, B, C])
    assert.ok(!JSON.stringify(audit).includes('sk-'), 'audit must never carry credentials')
    const direct = singleModelAuditFor(A)
    assert.deepEqual({ ...direct }, { attempts: 1, failoverNote: null, attemptedModels: [A], requestedChain: [A] })
  })
})
