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
