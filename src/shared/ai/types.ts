/**
 * Shared AI completion contracts (Stage 14).
 *
 * The renderer submits session references only. The main process
 * resolves provider, credential, model, history, and the fixed
 * developer instruction from trusted local state. No system prompt,
 * tools, messages, or URLs cross from the renderer.
 */

import type { CodingMessage, CodingSession } from '../sessions/types'
import type { ChangeTransaction } from '../change-transactions/types'
import type { ChangeSet } from '../change-sets/types'
import type { OrchestrationRun } from '../orchestration/types'
import type { RecoveryEvent } from '../recovery/types'

/** Generation request: which session's trailing user message to answer. */
export interface AiGenerateRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/** Generation result: the persisted assistant message plus session. */
export interface AiGenerateResult {
  readonly session: CodingSession
  readonly message: CodingMessage
}

/**
 * Code-proposal request (Stage 16): which session's trailing user
 * message to propose for. No path, content, revision, model, or
 * prompt — main derives authority from the persisted message.
 */
export interface AiProposeFileChangeRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/**
 * Code-proposal result: the pending Stage 9 transaction plus the
 * model summary. No API internals, reasoning, or credentials.
 */
export interface AiFileChangeProposalResult {
  readonly transaction: ChangeTransaction
  readonly summary: string
}

/**
 * Grouped code-proposal request (Stage 17): which session's trailing
 * user message to propose for. No paths, target IDs, code, model, or
 * revisions — main derives authority from persisted context.
 */
export interface AiProposeChangeSetRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/**
 * Grouped code-proposal result: the persisted Change Set holding one
 * pending transaction per changed file.
 */
export interface AiChangeSetProposalResult {
  readonly changeSet: ChangeSet
}

/**
 * Brain run request (Stage 18): which session's trailing user message
 * to answer. No model, prompt, instruction, context, or message ID —
 * main derives authority from the persisted message.
 */
export interface AiRunBrainRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/**
 * Brain run result: the persisted run (with steps) plus the final
 * assistant message and its session. No provider internals or
 * credentials.
 */
export interface AiRunBrainResult {
  readonly run: OrchestrationRun
  readonly message: CodingMessage
  readonly session: CodingSession
}

/** AI slice of the preload bridge (`window.stark.ai`). */
export interface AiApi {
  generateResponse: (request: AiGenerateRequest) => Promise<AskRecoveryResult>
  proposeFileChange: (request: AiProposeFileChangeRequest) => Promise<AiFileChangeProposalResult>
  proposeChangeSet: (request: AiProposeChangeSetRequest) => Promise<AiChangeSetProposalResult>
  runBrain: (request: AiRunBrainRequest) => Promise<WorkRecoveryResult>
}

/**
 * Discriminated Ask result (Stage 21): normal completion vs
 * single-hop recovery. Renderers must branch on `kind` — never parse
 * error strings. `completed` preserves the legacy shape.
 */
export type AskRecoveryResult =
  | { readonly kind: 'completed'; readonly result: AiGenerateResult }
  | {
      readonly kind: 'recovery_handoff'
      readonly targetSession: CodingSession
      readonly recoveryEvent: RecoveryEvent
      readonly failureCategory: string
    }
  | {
      readonly kind: 'recovered'
      readonly targetSession: CodingSession
      readonly recoveryEvent: RecoveryEvent
      readonly assistantMessage: CodingMessage
    }

/**
 * Discriminated Work result (Stage 21 + Stage 23): normal completion
 * vs single-hop whole-restart recovery vs waiting for exact
 * per-action approval. Renderers must branch on `kind`.
 */
export type WorkRecoveryResult =
  | { readonly kind: 'completed'; readonly result: AiRunBrainResult }
  | {
      readonly kind: 'recovery_handoff'
      readonly targetSession: CodingSession
      readonly recoveryEvent: RecoveryEvent
      readonly failureCategory: string
    }
  | {
      readonly kind: 'recovered'
      readonly targetSession: CodingSession
      readonly recoveryEvent: RecoveryEvent
      readonly run: OrchestrationRun
      readonly assistantMessage: CodingMessage
    }
  | {
      readonly kind: 'waiting_for_approval'
      readonly session: CodingSession
      readonly run: OrchestrationRun
      readonly approval: import('../worker-tools/types').WorkerToolApproval
    }
