/**
 * Shared AI completion contracts (Stage 14).
 *
 * The renderer submits session references only. The main process
 * resolves provider, credential, model, history, and the fixed
 * developer instruction from trusted local state. No system prompt,
 * tools, messages, or URLs cross from the renderer.
 */

import type { CodingMessage, CodingSession } from '../sessions/types'

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

/** AI slice of the preload bridge (`window.stark.ai`). */
export interface AiApi {
  generateResponse: (request: AiGenerateRequest) => Promise<AiGenerateResult>
}
