import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  STARK_HOSTED_MODEL_COUNT,
  STARK_HOSTED_MODEL_ROUTES,
  hostedModelSupportsVision,
  isHostedBuiltinModel,
  resolveHostedModelRoute
} from './stark-model-map'

/**
 * Canonical hosted map proof: exactly the 15 verified OpenRouter
 * routes, evidence-based capability flags, dot/dash resolution, and
 * parity with the Edge Function copy (which must stay
 * self-contained for deployment).
 */

describe('hosted model map', () => {
  it('contains exactly the 15 verified routes', () => {
    assert.equal(STARK_HOSTED_MODEL_COUNT, 15)
    assert.equal(STARK_HOSTED_MODEL_ROUTES.length, 15)
    assert.deepEqual(
      STARK_HOSTED_MODEL_ROUTES.map((entry) => [entry.builtinId, entry.openRouterId]),
      [
        ['builtin:muse-spark-1.3', 'meta/muse-spark-1.3'],
        ['builtin:glm-5.3-flash', 'z-ai/glm-5.3-flash'],
        ['builtin:deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'],
        ['builtin:gpt-5.6-luna', 'openai/gpt-5.6-luna'],
        ['builtin:gemini-2.5-flash', 'google/gemini-2.5-flash'],
        ['builtin:claude-haiku-5.5', 'anthropic/claude-haiku-5.5'],
        ['builtin:minimax-m3', 'minimax/minimax-m3'],
        ['builtin:kimi-k2.7-code', 'moonshotai/kimi-k2.7-code'],
        ['builtin:mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro'],
        ['builtin:mimo-v2.6-flash', 'xiaomi/mimo-v2.6-flash'],
        ['builtin:nemotron-3.5-lightning', 'nvidia/nemotron-3.5-lightning'],
        ['builtin:deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
        ['builtin:muse-spark-1.2', 'meta/muse-spark-1.2'],
        ['builtin:longcat-2.0', 'meituan/longcat-2.0'],
        ['builtin:mistral-large-4', 'mistralai/mistral-large-4-0']
      ]
    )
  })

  it('resolves dot and dash transcriptions, rejects everything else', () => {
    assert.equal(resolveHostedModelRoute('builtin:gpt-5.6-luna')?.openRouterId, 'openai/gpt-5.6-luna')
    assert.equal(resolveHostedModelRoute('builtin:gpt-5-6-luna')?.openRouterId, 'openai/gpt-5.6-luna')
    assert.ok(isHostedBuiltinModel('builtin:longcat-2-0'))
    for (const bad of ['', 'gpt-4o', 'openai:gpt-4o', 'openai/gpt-5.6-luna', 'builtin:unknown', 'stark:gpt-5.6-luna']) {
      assert.equal(resolveHostedModelRoute(bad), null, `${bad} must not resolve`)
      assert.equal(isHostedBuiltinModel(bad), false)
    }
  })

  it('encodes evidence-based capability flags', () => {
    assert.equal(resolveHostedModelRoute('builtin:longcat-2.0')?.structuredOutputs, false)
    assert.equal(resolveHostedModelRoute('builtin:gemini-2.5-flash')?.reasoningEffort, false)
    assert.equal(resolveHostedModelRoute('builtin:gpt-5.6-luna')?.reasoningEffort, true)
    assert.equal(hostedModelSupportsVision('builtin:gpt-5.6-luna'), true)
    assert.equal(hostedModelSupportsVision('builtin:nemotron-3.5-lightning'), false)
    assert.equal(hostedModelSupportsVision('builtin:deepseek-v4-flash'), false)
    assert.equal(hostedModelSupportsVision('builtin:longcat-2.0'), false)
    assert.equal(hostedModelSupportsVision('openai:gpt-4o'), false)
  })

  it('stays in parity with the Edge Function copy', () => {
    const edge = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'stark-infer', 'model-map.ts'),
      'utf8'
    )
    for (const route of STARK_HOSTED_MODEL_ROUTES) {
      assert.ok(edge.includes(`builtinId: '${route.builtinId}'`), `edge copy must list ${route.builtinId}`)
      assert.ok(edge.includes(`openRouterId: '${route.openRouterId}'`), `edge copy must map ${route.openRouterId}`)
      assert.ok(
        edge.includes(`structuredOutputs: ${String(route.structuredOutputs)}`),
        `edge copy must carry flags for ${route.builtinId}`
      )
    }
    const edgeIds = [...edge.matchAll(/builtinId: '([^']+)'/g)].map((match) => match[1])
    assert.deepEqual(edgeIds, STARK_HOSTED_MODEL_ROUTES.map((entry) => entry.builtinId))
  })
})
