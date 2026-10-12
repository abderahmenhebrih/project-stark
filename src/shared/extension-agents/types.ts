/**
 * Shared extension-agent contracts (generic VS Code extension
 * compatibility foundation).
 *
 * Plain TypeScript only — no Node.js or DOM APIs. Importable from
 * main, preload, renderer, and the Node test runner.
 *
 * Extension identity is DATA, never a vendor union: any installed
 * extension whose manifest declares a recognized agent contribution
 * (standard `chatParticipants` entries mapped to a contributed
 * command) may appear as a composer target. Formatters, linters,
 * themes, and language extensions carry no such contribution and
 * never appear here.
 */

import type { CodingMessage, CodingSession } from '../sessions/types'

/** Capability flags one agent provider exposes (all bounded, safe). */
export interface ExtensionAgentCapabilities {
  /** Provider accepts conversational prompts. */
  readonly chat: boolean
  /** Provider streams partial output (else single final message). */
  readonly streaming: boolean
  /** Provider may request tool use (still gated by STARK approvals). */
  readonly tools: boolean
  /** Provider may return file proposals (Review-before-write applies). */
  readonly proposals: boolean
  /** A started run can be cancelled. */
  readonly cancellation: boolean
}

/** Honest availability for one agent provider (sanitized, no secrets). */
export type ExtensionAgentAvailabilityStatus = 'available' | 'unavailable' | 'connecting' | 'running' | 'error'

export interface ExtensionAgentAvailability {
  readonly status: ExtensionAgentAvailabilityStatus
  /** Concise human reason when not available (generic copy, no vendor special cases). */
  readonly reason: string | null
  /** Owning extension version when known (display only). */
  readonly version: string | null
}

/**
 * Renderer-safe agent provider row: everything the composer target
 * menu needs, nothing privileged. Icon is the extension's own
 * installed/package artwork (opaque URL or null → generic fallback).
 */
export interface ExtensionAgentProviderInfo {
  /** Owning extension coordinates (`namespace.name`). */
  readonly extensionId: string
  readonly namespace: string
  readonly name: string
  readonly version: string
  /** Stable provider id declared by the extension's own manifest. */
  readonly providerId: string
  readonly displayName: string
  readonly iconUrl: string | null
  readonly capabilities: ExtensionAgentCapabilities
  readonly availability: ExtensionAgentAvailability
}

/**
 * Agent run request: session references only. The prompt is the
 * session's trailing user message (main-derived, like the Brain
 * path). STARK effort settings are NEVER accepted here — extensions
 * control their own model/reasoning behavior.
 */
export interface ExtensionAgentRunRequest {
  readonly workspaceId: number
  readonly sessionId: number
  readonly extensionId: string
  readonly providerId: string
}

/** One structured whole-file edit proposed by an agent run. */
export interface ExtensionAgentProposedEdit {
  readonly relativePath: string
  readonly proposedContent: string
}

/** Sanitized agent run outcome: text plus reviewable proposals. */
export interface ExtensionAgentRunResult {
  readonly session: CodingSession
  readonly message: CodingMessage
  /** Pending transaction ids created for proposed edits (human Accept required). */
  readonly proposalTransactionIds: readonly number[]
}

/** Extension-agent slice of the preload bridge (`window.stark.extensionAgents`). */
export interface ExtensionAgentsApi {
  listProviders: () => Promise<readonly ExtensionAgentProviderInfo[]>
  runAgent: (request: ExtensionAgentRunRequest) => Promise<ExtensionAgentRunResult>
}
