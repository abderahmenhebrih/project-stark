import { TextEncoder } from 'node:util'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { MAX_AI_CONTEXT_BYTES, MAX_AI_CONTEXT_MESSAGES } from './limits'

const encoder = new TextEncoder()

/**
 * Single bounded provider-context loader shared by every AI path
 * (Ask, Brain plan/worker/synthesis, single/multi proposals, Worker
 * tool runs). Previously each service carried its own copy of this
 * exact truncation; the semantics below are byte-identical to all
 * of them, so extraction changes no runtime behavior:
 *
 * - newest-first probe (limit + 1 hasMore row), at most
 *   MAX_AI_CONTEXT_MESSAGES newest rows;
 * - drop oldest while over MAX_AI_CONTEXT_BYTES, always retaining
 *   the trailing user message (probe index 0 survives: the loop
 *   stops at length 1);
 * - whole messages only — content is never sliced, so multi-byte
 *   UTF-8 can never split mid-sequence;
 * - chronological return for provider consumption.
 *
 * No summarization, no token counting, no hidden loss beyond the
 * documented oldest-first budget rule.
 */
export function loadBoundedContext(
  sessions: Pick<CodingSessionRepository, 'listMessagesNewestFirst'>,
  sessionId: number
): { readonly role: 'user' | 'assistant'; readonly content: string }[] {
  const probe = sessions.listMessagesNewestFirst(sessionId, MAX_AI_CONTEXT_MESSAGES, null)
  const kept = [...probe.slice(0, MAX_AI_CONTEXT_MESSAGES)]
  let total = 0
  for (const entry of kept) {
    total += encoder.encode(entry.content).byteLength
  }
  while (kept.length > 1 && total > MAX_AI_CONTEXT_BYTES) {
    const dropped = kept.pop()
    if (dropped !== undefined) {
      total -= encoder.encode(dropped.content).byteLength
    }
  }
  return kept.reverse().map((entry) => ({ role: entry.role, content: entry.content }))
}
