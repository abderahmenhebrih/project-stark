/**
 * Shared Looplink domain contract (Stage 20).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * A Looplink is a persistent, immutable, bounded historical handoff
 * from a source coding Session to a newly created target Session in
 * the same Workspace. It carries continuity, never authority:
 * historical file context inside a Looplink is conversational data,
 * not fresh Stage 15 attachment authority for proposals.
 */

import type { SessionContextKind } from '../context/types'

/** Lifecycle of a Looplink handoff. Terminal states never transition. */
export type LooplinkStatus = 'pending' | 'consumed' | 'dismissed'

/** One message captured in a Looplink snapshot. */
export interface LooplinkMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly createdAt: number
}

/** One explicitly sent context item captured in a snapshot. */
export interface LooplinkContextItem {
  readonly kind: SessionContextKind
  readonly label: string
  readonly relativePath: string | null
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
}

/** Orchestration metadata captured in a snapshot. */
export interface LooplinkOrchestration {
  readonly status: string
  readonly action: string | null
  readonly planSummary: string | null
  readonly workerResult: string | null
  readonly workerResultOmitted: boolean
}

/** Change metadata reference captured in a snapshot. */
export interface LooplinkChangeReference {
  readonly kind: 'transaction' | 'change-set-item'
  readonly transactionId: number
  readonly changeSetId: number | null
  readonly relativePath: string
  readonly summary: string
  readonly status: string
  readonly groupStatus: string | null
}

/** Omission accounting for a snapshot. */
export interface LooplinkOmissions {
  readonly messageCount: number
  readonly contextCount: number
  readonly workerResultOmitted: boolean
  readonly changeCount: number
}

/** Versioned immutable snapshot payload. */
export interface LooplinkPayloadV1 {
  readonly version: 1
  readonly source: {
    readonly sessionId: number
    readonly title: string
  }
  readonly messages: readonly LooplinkMessage[]
  readonly explicitContext: readonly LooplinkContextItem[]
  readonly orchestration: LooplinkOrchestration | null
  readonly changes: readonly LooplinkChangeReference[]
  readonly omissions: LooplinkOmissions
}

/** Public handoff: header plus verified payload. */
export interface LooplinkHandoff {
  readonly id: number
  readonly workspaceId: number
  readonly sourceSessionId: number
  readonly targetSessionId: number
  readonly status: LooplinkStatus
  readonly payload: LooplinkPayloadV1
  readonly payloadBytes: number
  readonly payloadHash: string
  readonly createdAt: number
  readonly consumedAt: number | null
  readonly dismissedAt: number | null
}

/** Renderer-safe preview of a pending handoff. */
export interface LooplinkPreview {
  readonly id: number
  readonly status: LooplinkStatus
  readonly sourceTitle: string
  readonly createdAt: number
  readonly payload: LooplinkPayloadV1
}

/** Create-continuation request: source session only. */
export interface CreateLooplinkRequest {
  readonly workspaceId: number
  readonly sourceSessionId: number
}

/** Create-continuation result. No message is sent automatically. */
export interface CreateLooplinkResult {
  readonly targetSession: import('../sessions/types').CodingSession
  readonly looplink: LooplinkPreview
}

/** Session-scoped pending-handoff lookup. */
export interface LooplinkForSessionRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/** Looplink slice of the preload bridge (`window.stark.looplink`). */
export interface LooplinkApi {
  createContinuation: (request: CreateLooplinkRequest) => Promise<CreateLooplinkResult>
  getForSession: (request: LooplinkForSessionRequest) => Promise<LooplinkPreview | null>
  dismiss: (request: LooplinkForSessionRequest) => Promise<LooplinkPreview>
}
