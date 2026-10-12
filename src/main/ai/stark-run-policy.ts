/**
 * Central STARK effort runtime policy (composer hardening).
 *
 * ONE typed policy function — no scattered `if (effort === …)`
 * throughout the codebase. Callers pass the user-selected effort
 * plus the resolved model id; every STARK-owned budget comes back in
 * one object. All levels share exactly the same capabilities,
 * approvals, review-before-write, transaction validation, workspace
 * boundaries, and auth — effort changes thoroughness, never privilege.
 *
 * REGULAR reproduces the current STARK runtime baseline exactly:
 * - 1 Brain plan + at most 1 Worker + 1 synthesis (3 calls max)
 * - worker tools bounded by MAX_WORKER_TOOL_CALLS (4)
 * - structured-output single attempt
 * - 4096 output tokens, 150s orchestration deadline
 * - NO provider reasoning parameter (current behavior)
 */

import type { StarkEffort } from '../../shared/agent-target/types'
import {
  AI_GENERATE_TIMEOUT_MS,
  MAX_ASSISTANT_OUTPUT_TOKENS,
  MAX_ORCHESTRATION_RUN_MS
} from './limits'
import { MAX_WORKER_TOOL_CALLS } from '../worker-tools/worker-tool-limits'

/** Officially supported provider reasoning values (OpenAI SDK). */
export type ProviderReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Verification strictness applied to STARK-owned result checks. */
export type StarkVerificationLevel = 0 | 1 | 2 | 3

export interface StarkRunPolicy {
  /** Bounded Brain planning attempts (structured plan calls). */
  readonly brainPlanningBudget: number
  /** Bounded Worker tool-round budget for this run. */
  readonly maxWorkerToolRounds: number
  /** STARK-owned verification strictness (higher = more checks). */
  readonly verificationLevel: StarkVerificationLevel
  /** Bounded recovery attempts available to this run. */
  readonly recoveryBudget: number
  /** Bounded structured-output repeats on plan-shape validation failure. */
  readonly structuredOutputRepeatBudget: number
  /**
   * Provider reasoning effort to send, or null for current/default
   * provider behavior (no parameter). Never an unsupported literal:
   * callers must pass it through model-capability gating first
   * (see providerReasoningForModel).
   */
  readonly providerReasoningEffort: ProviderReasoningEffort | null
  /** Bounded output-token budget requested from the provider. */
  readonly maxOutputTokens: number
  /** Bounded orchestration deadline for this run (ms). */
  readonly orchestrationTimeoutMs: number
}

/** Absolute hard caps: no effort level may exceed these. */
export const STARK_POLICY_ABSOLUTE_CAPS = {
  maxWorkerToolRounds: 10,
  maxOutputTokens: 8192,
  orchestrationTimeoutMs: 180000,
  structuredOutputRepeatBudget: 2
} as const

const BASELINE_TOOL_ROUNDS = MAX_WORKER_TOOL_CALLS

/**
 * Conservative model-capability gate for the provider reasoning
 * parameter. Only reasoning-capable OpenAI families accept it
 * (o-series, gpt-5); classic chat models (gpt-4o, gpt-4, gpt-3.5)
 * must receive NO reasoning parameter or the call fails.
 */
export function supportsProviderReasoning(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (id === '') {
    return false
  }
  return (
    /(^|[^a-z0-9])(o1|o3|o4)([^a-z0-9]|$)/.test(id) ||
    id.includes('gpt-5') ||
    id.includes('reasoning')
  )
}

/**
 * Maps an effort + model to the single reasoning value the provider
 * may receive, or null when no parameter must be sent (regular
 * baseline behavior, or a model without reasoning support). XHigh
 * deliberately uses provider `high` (highest widely supported) plus
 * stronger STARK-internal budgets — never an unsupported literal.
 */
export function providerReasoningForModel(
  effort: StarkEffort,
  modelId: string
): ProviderReasoningEffort | null {
  if (!supportsProviderReasoning(modelId)) {
    return null
  }
  switch (effort) {
    case 'light':
      return 'minimal'
    case 'regular':
      return null
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'high'
  }
}

/**
 * Derives the full STARK-owned run policy for one effort level.
 * Regular equals the previous baseline; Light reduces optional
 * budgets; Medium/High/XHigh raise them monotonically within hard
 * safe caps. modelId gates ONLY the provider reasoning field —
 * every STARK-owned budget applies regardless of provider support
 * so effort works even when reasoning controls are unavailable.
 */
export function deriveStarkRunPolicy(effort: StarkEffort, modelId: string): StarkRunPolicy {
  const providerReasoningEffort = providerReasoningForModel(effort, modelId)
  switch (effort) {
    case 'light':
      return {
        brainPlanningBudget: 1,
        maxWorkerToolRounds: Math.min(2, STARK_POLICY_ABSOLUTE_CAPS.maxWorkerToolRounds),
        verificationLevel: 0,
        recoveryBudget: 0,
        structuredOutputRepeatBudget: 0,
        providerReasoningEffort,
        maxOutputTokens: Math.min(2048, MAX_ASSISTANT_OUTPUT_TOKENS),
        orchestrationTimeoutMs: Math.min(90000, MAX_ORCHESTRATION_RUN_MS)
      }
    case 'regular':
      return {
        brainPlanningBudget: 1,
        maxWorkerToolRounds: BASELINE_TOOL_ROUNDS,
        verificationLevel: 1,
        recoveryBudget: 1,
        structuredOutputRepeatBudget: 0,
        providerReasoningEffort,
        maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS,
        orchestrationTimeoutMs: MAX_ORCHESTRATION_RUN_MS
      }
    case 'medium':
      return {
        brainPlanningBudget: 1,
        maxWorkerToolRounds: Math.min(BASELINE_TOOL_ROUNDS + 2, STARK_POLICY_ABSOLUTE_CAPS.maxWorkerToolRounds),
        verificationLevel: 2,
        recoveryBudget: 1,
        structuredOutputRepeatBudget: 1,
        providerReasoningEffort,
        maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS,
        orchestrationTimeoutMs: MAX_ORCHESTRATION_RUN_MS
      }
    case 'high':
      return {
        brainPlanningBudget: 2,
        maxWorkerToolRounds: Math.min(BASELINE_TOOL_ROUNDS + 4, STARK_POLICY_ABSOLUTE_CAPS.maxWorkerToolRounds),
        verificationLevel: 2,
        recoveryBudget: 2,
        structuredOutputRepeatBudget: 1,
        providerReasoningEffort,
        maxOutputTokens: Math.min(MAX_ASSISTANT_OUTPUT_TOKENS * 2, STARK_POLICY_ABSOLUTE_CAPS.maxOutputTokens),
        orchestrationTimeoutMs: Math.min(MAX_ORCHESTRATION_RUN_MS + 30000, STARK_POLICY_ABSOLUTE_CAPS.orchestrationTimeoutMs)
      }
    case 'xhigh':
      return {
        brainPlanningBudget: 2,
        maxWorkerToolRounds: STARK_POLICY_ABSOLUTE_CAPS.maxWorkerToolRounds,
        verificationLevel: 3,
        recoveryBudget: 2,
        structuredOutputRepeatBudget: STARK_POLICY_ABSOLUTE_CAPS.structuredOutputRepeatBudget,
        providerReasoningEffort,
        maxOutputTokens: Math.min(MAX_ASSISTANT_OUTPUT_TOKENS * 2, STARK_POLICY_ABSOLUTE_CAPS.maxOutputTokens),
        orchestrationTimeoutMs: STARK_POLICY_ABSOLUTE_CAPS.orchestrationTimeoutMs
      }
  }
}

/** AI_GENERATE_TIMEOUT_MS re-export for effort-aware callers. */
export const STARK_BASE_GENERATE_TIMEOUT_MS = AI_GENERATE_TIMEOUT_MS
