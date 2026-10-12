import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GenerationInFlightError,
  InvalidProviderRequestError,
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
  eligibleLoopLinkModels,
  isRetryableLoopLinkError,
  readLoopLinkChain,
  runLoopLinkChain
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
})
