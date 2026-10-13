import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AI_GENERATE_TIMEOUT_MS,
  MAX_ASSISTANT_OUTPUT_TOKENS,
  MAX_ORCHESTRATION_RUN_MS
} from './limits'
import { MAX_WORKER_TOOL_CALLS } from '../worker-tools/worker-tool-limits'
import {
  STARK_POLICY_ABSOLUTE_CAPS,
  deriveStarkRunPolicy,
  providerReasoningForModel,
  supportsProviderReasoning
} from './stark-run-policy'

describe('stark run policy: regular is the baseline', () => {
  it('regular reproduces current runtime behavior exactly', () => {
    const policy = deriveStarkRunPolicy('regular', 'gpt-4o')
    assert.equal(policy.brainPlanningBudget, 1)
    assert.equal(policy.maxWorkerToolRounds, MAX_WORKER_TOOL_CALLS)
    assert.equal(policy.structuredOutputRepeatBudget, 0)
    assert.equal(policy.maxOutputTokens, MAX_ASSISTANT_OUTPUT_TOKENS)
    assert.equal(policy.orchestrationTimeoutMs, MAX_ORCHESTRATION_RUN_MS)
    // Current behavior sends NO reasoning parameter.
    assert.equal(policy.providerReasoningEffort, null)
  })

  it('regular keeps the baseline even for reasoning-capable models', () => {
    const policy = deriveStarkRunPolicy('regular', 'gpt-5')
    assert.equal(policy.providerReasoningEffort, null)
    assert.equal(policy.maxOutputTokens, MAX_ASSISTANT_OUTPUT_TOKENS)
  })
})

describe('stark run policy: real ascending budgets', () => {
  it('light reduces optional budgets below regular', () => {
    const light = deriveStarkRunPolicy('light', 'gpt-4o')
    const regular = deriveStarkRunPolicy('regular', 'gpt-4o')
    assert.ok(light.maxWorkerToolRounds < regular.maxWorkerToolRounds)
    assert.ok(light.maxOutputTokens <= regular.maxOutputTokens)
    assert.ok(light.orchestrationTimeoutMs <= regular.orchestrationTimeoutMs)
    assert.ok(light.verificationLevel <= regular.verificationLevel)
  })

  it('medium exceeds regular and high exceeds medium', () => {
    const regular = deriveStarkRunPolicy('regular', 'gpt-4o')
    const medium = deriveStarkRunPolicy('medium', 'gpt-4o')
    const high = deriveStarkRunPolicy('high', 'gpt-4o')
    assert.ok(medium.maxWorkerToolRounds > regular.maxWorkerToolRounds)
    assert.ok(medium.verificationLevel > regular.verificationLevel)
    assert.ok(medium.structuredOutputRepeatBudget >= regular.structuredOutputRepeatBudget)
    assert.ok(high.maxWorkerToolRounds > medium.maxWorkerToolRounds)
    assert.ok(high.brainPlanningBudget >= medium.brainPlanningBudget)
  })

  it('xhigh is the strongest bounded policy with stronger verification than high', () => {
    const high = deriveStarkRunPolicy('high', 'gpt-4o')
    const xhigh = deriveStarkRunPolicy('xhigh', 'gpt-4o')
    assert.ok(xhigh.maxWorkerToolRounds >= high.maxWorkerToolRounds)
    assert.ok(xhigh.verificationLevel > high.verificationLevel)
    assert.ok(xhigh.structuredOutputRepeatBudget >= high.structuredOutputRepeatBudget)
    assert.ok(xhigh.maxWorkerToolRounds <= STARK_POLICY_ABSOLUTE_CAPS.maxWorkerToolRounds)
    assert.ok(xhigh.maxOutputTokens <= STARK_POLICY_ABSOLUTE_CAPS.maxOutputTokens)
    assert.ok(xhigh.orchestrationTimeoutMs <= STARK_POLICY_ABSOLUTE_CAPS.orchestrationTimeoutMs)
    assert.ok(xhigh.structuredOutputRepeatBudget <= STARK_POLICY_ABSOLUTE_CAPS.structuredOutputRepeatBudget)
  })

  it('every level stays within hard safe caps', () => {
    for (const effort of ['light', 'regular', 'medium', 'high', 'xhigh'] as const) {
      const policy = deriveStarkRunPolicy(effort, 'gpt-4o')
      assert.ok(policy.maxWorkerToolRounds >= 1 && policy.maxWorkerToolRounds <= STARK_POLICY_ABSOLUTE_CAPS.maxWorkerToolRounds)
      assert.ok(policy.brainPlanningBudget >= 1 && policy.brainPlanningBudget <= 2)
      assert.ok(policy.orchestrationTimeoutMs > 0 && policy.orchestrationTimeoutMs <= STARK_POLICY_ABSOLUTE_CAPS.orchestrationTimeoutMs)
    }
  })
})

describe('provider reasoning capability gating', () => {
  it('classic chat models never receive a reasoning parameter', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', '']) {
      assert.equal(supportsProviderReasoning(model), false, `${model} must not support reasoning`)
      for (const effort of ['light', 'regular', 'medium', 'high', 'xhigh'] as const) {
        assert.equal(providerReasoningForModel(effort, model), null, `${effort}/${model} must send nothing`)
        assert.equal(deriveStarkRunPolicy(effort, model).providerReasoningEffort, null)
      }
    }
  })

  it('reasoning-capable models receive only officially supported values', () => {
    assert.ok(supportsProviderReasoning('gpt-5'))
    assert.ok(supportsProviderReasoning('o1'))
    assert.ok(supportsProviderReasoning('o3-mini'))
    assert.equal(providerReasoningForModel('light', 'gpt-5'), 'minimal')
    assert.equal(providerReasoningForModel('regular', 'gpt-5'), null)
    assert.equal(providerReasoningForModel('medium', 'gpt-5'), 'medium')
    assert.equal(providerReasoningForModel('high', 'gpt-5'), 'high')
    // XHigh uses provider `high` (highest widely supported) plus
    // stronger STARK-internal budgets — never an unsupported literal.
    assert.equal(providerReasoningForModel('xhigh', 'gpt-5'), 'high')
  })

  it('effort never changes capabilities, approvals, or write authority', () => {
    // The policy carries budgets only: no capability flags, no auth,
    // no workspace paths, no approval overrides exist on the shape.
    for (const effort of ['light', 'regular', 'medium', 'high', 'xhigh'] as const) {
      const policy = deriveStarkRunPolicy(effort, 'gpt-5') as unknown as Record<string, unknown>
      const keys = Object.keys(policy).sort()
      assert.deepEqual(keys, [
        'brainPlanningBudget',
        'maxOutputTokens',
        'maxWorkerToolRounds',
        'orchestrationTimeoutMs',
        'providerReasoningEffort',
        'recoveryBudget',
        'structuredOutputRepeatBudget',
        'verificationLevel'
      ])
    }
  })

  it('base generate timeout import keeps callers honest', () => {
    assert.ok(AI_GENERATE_TIMEOUT_MS > 0)
  })
})

describe('provider reasoning: hosted builtin metadata is authoritative', () => {
  const REASONING_TRUE = [
    'builtin:muse-spark-1.3',
    'builtin:glm-5.3-flash',
    'builtin:deepseek-v4.1-flash',
    'builtin:gpt-5.6-luna',
    'builtin:claude-haiku-5.5',
    'builtin:mimo-v2.6-flash',
    'builtin:nemotron-3.5-lightning',
    'builtin:deepseek-v4-flash',
    'builtin:muse-spark-1.2',
    'builtin:mistral-large-4'
  ]
  const REASONING_FALSE = [
    'builtin:gemini-2.5-flash',
    'builtin:minimax-m3',
    'builtin:kimi-k2.7-code',
    'builtin:mimo-v2.6-pro',
    'builtin:longcat-2.0'
  ]

  it('hosted reasoningEffort:true models receive effort-mapped reasoning', () => {
    for (const model of REASONING_TRUE) {
      assert.equal(supportsProviderReasoning(model), true, `${model} must support reasoning`)
      assert.equal(providerReasoningForModel('light', model), 'minimal')
      assert.equal(providerReasoningForModel('regular', model), null)
      assert.equal(providerReasoningForModel('medium', model), 'medium')
      assert.equal(providerReasoningForModel('high', model), 'high')
      assert.equal(providerReasoningForModel('xhigh', model), 'high')
    }
  })

  it('hosted reasoningEffort:false models never receive reasoning at any effort', () => {
    for (const model of REASONING_FALSE) {
      assert.equal(supportsProviderReasoning(model), false, `${model} must not support reasoning`)
      for (const effort of ['light', 'regular', 'medium', 'high', 'xhigh'] as const) {
        assert.equal(providerReasoningForModel(effort, model), null, `${effort}/${model} must send nothing`)
        assert.equal(deriveStarkRunPolicy(effort, model).providerReasoningEffort, null)
      }
    }
  })

  it('gpt-5.6-luna and DeepSeek hosted models follow the map, not the name regex', () => {
    // gpt-5.6-luna matches both map (true) and regex — must be true.
    assert.equal(supportsProviderReasoning('builtin:gpt-5.6-luna'), true)
    // DeepSeek ids contain no OpenAI-family marker — map alone must grant it.
    assert.equal(supportsProviderReasoning('builtin:deepseek-v4.1-flash'), true)
    assert.equal(supportsProviderReasoning('builtin:deepseek-v4-flash'), true)
    // A non-reasoning hosted id containing no marker stays false.
    assert.equal(supportsProviderReasoning('builtin:gemini-2.5-flash'), false)
  })

  it('dash-transcribed hosted ids resolve identically', () => {
    assert.equal(supportsProviderReasoning('builtin:deepseek-v4-1-flash'), true)
    assert.equal(supportsProviderReasoning('builtin:gpt-5-6-luna'), true)
    assert.equal(supportsProviderReasoning('builtin:gemini-2-5-flash'), false)
  })

  it('external OpenAI fallback preserved when no hosted metadata exists', () => {
    assert.equal(supportsProviderReasoning('gpt-5'), true)
    assert.equal(supportsProviderReasoning('gpt-5-mini'), true)
    assert.equal(supportsProviderReasoning('o1'), true)
    assert.equal(supportsProviderReasoning('gpt-4o'), false)
    assert.equal(providerReasoningForModel('medium', 'gpt-5'), 'medium')
    assert.equal(providerReasoningForModel('medium', 'gpt-4o'), null)
  })

  it('invalid and unknown models fail closed', () => {
    for (const model of ['', '   ', 'builtin:unknown-model', 'openai:gpt-4o', 'stark:evil']) {
      assert.equal(supportsProviderReasoning(model), false, `${model} must fail closed`)
      assert.equal(providerReasoningForModel('high', model), null)
    }
  })

  it('effort still moves STARK-owned budgets for non-reasoning hosted models', () => {
    const light = deriveStarkRunPolicy('light', 'builtin:gemini-2.5-flash')
    const xhigh = deriveStarkRunPolicy('xhigh', 'builtin:gemini-2.5-flash')
    assert.equal(light.providerReasoningEffort, null)
    assert.equal(xhigh.providerReasoningEffort, null)
    assert.ok(xhigh.maxWorkerToolRounds >= light.maxWorkerToolRounds)
    assert.ok(xhigh.maxOutputTokens >= light.maxOutputTokens)
    assert.ok(xhigh.orchestrationTimeoutMs >= light.orchestrationTimeoutMs)
    assert.ok(xhigh.verificationLevel >= light.verificationLevel)
  })
})
