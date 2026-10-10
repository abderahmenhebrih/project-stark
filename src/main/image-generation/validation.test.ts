import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidImageGenerationRequestError } from './errors'
import {
  WORKER_IMAGE_GENERATE_DENY_MESSAGE,
  WORKER_IMAGE_GENERATE_USER_DENY_MESSAGE,
  buildImageGenerateApprovalSummary,
  parseImageGenerateArgs
} from './validation'

describe('image_generate validation', () => {
  it('parses prompt/count/closed size with no provider authority', () => {
    const parsed = parseImageGenerateArgs({ prompt: 'a cyberpunk hero', count: 2, size: '1024x1024' })
    assert.deepEqual(parsed, { prompt: 'a cyberpunk hero', count: 2, size: '1024x1024' })
    const minimal = parseImageGenerateArgs({ prompt: 'logo', count: 1 })
    assert.deepEqual(minimal, { prompt: 'logo', count: 1, size: undefined })
  })

  it('rejects out-of-bounds prompts and counts', () => {
    assert.throws(() => parseImageGenerateArgs({ prompt: '', count: 1 }), InvalidImageGenerationRequestError)
    assert.throws(() => parseImageGenerateArgs({ prompt: 'x', count: 0 }), InvalidImageGenerationRequestError)
    assert.throws(() => parseImageGenerateArgs({ prompt: 'x', count: 5 }), InvalidImageGenerationRequestError)
    assert.throws(() => parseImageGenerateArgs({ prompt: 'x', count: 1.5 }), InvalidImageGenerationRequestError)
    assert.throws(() => parseImageGenerateArgs({ prompt: 'x', count: '2' }), InvalidImageGenerationRequestError)
    assert.throws(() => parseImageGenerateArgs({ prompt: 'x'.repeat(4001), count: 1 }), InvalidImageGenerationRequestError)
  })

  it('rejects unsupported options and model-supplied provider fields', () => {
    assert.throws(() => parseImageGenerateArgs({ prompt: 'x', count: 1, size: '4096x4096' }), InvalidImageGenerationRequestError)
    assert.throws(
      () => parseImageGenerateArgs({ prompt: 'x', count: 1, providerUrl: 'https://evil.example/' }),
      InvalidImageGenerationRequestError
    )
    assert.throws(
      () => parseImageGenerateArgs({ prompt: 'x', count: 1, apiKey: 'sk-x' }),
      InvalidImageGenerationRequestError
    )
    assert.throws(
      () => parseImageGenerateArgs({ prompt: 'x', count: 1, destination: 'public/x.png' }),
      InvalidImageGenerationRequestError
    )
    assert.throws(
      () => parseImageGenerateArgs({ prompt: 'x', count: 1, model: 'other' }),
      InvalidImageGenerationRequestError
    )
  })

  it('builds cost-disclosing approval copy', () => {
    const single = buildImageGenerateApprovalSummary({ prompt: 'x', count: 1, size: undefined })
    assert.ok(single.includes('Generate 1 image'))
    assert.ok(single.includes('may use provider credits') || single.includes('provider credits'))
    const multi = buildImageGenerateApprovalSummary({ prompt: 'x', count: 4, size: undefined })
    assert.ok(multi.includes('Generate 4 images'))
  })

  it('carries safe deny copy', () => {
    assert.ok(WORKER_IMAGE_GENERATE_DENY_MESSAGE.length > 0)
    assert.ok(WORKER_IMAGE_GENERATE_USER_DENY_MESSAGE.length > 0)
    assert.ok(!WORKER_IMAGE_GENERATE_DENY_MESSAGE.includes('sk-'))
  })
})
