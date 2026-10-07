/**
 * Pure composer keyboard decision (no React/DOM imports) so Enter to
 * send, Shift+Enter for newline, IME-composition guarding, and
 * send-gating are unit-testable with the Node runner.
 */

export interface ComposerKeyEvent {
  readonly key: string
  readonly shiftKey: boolean
  readonly isComposing: boolean
}

export interface ComposerSendGate {
  /** No active session selected. */
  readonly hasSession: boolean
  /** Composer content is empty/whitespace-only. */
  readonly isEmpty: boolean
  /** A send is already in flight. */
  readonly sending: boolean
  /** Content exceeds the main-process byte limit. */
  readonly overLimit: boolean
}

/**
 * Returns true only for a plain Enter press that should submit:
 * Shift+Enter stays a newline, IME composition never submits, and the
 * send gate (session, emptiness, in-flight, limit) must pass.
 */
export function shouldSubmitComposerKey(event: ComposerKeyEvent, gate: ComposerSendGate): boolean {
  if (event.key !== 'Enter') {
    return false
  }
  if (event.shiftKey) {
    return false
  }
  if (event.isComposing) {
    return false
  }
  if (!gate.hasSession || gate.isEmpty || gate.sending || gate.overLimit) {
    return false
  }
  return true
}

/** Shared emptiness rule with the main-process validator. */
export function isComposerEmpty(content: string): boolean {
  return content.trim().length === 0
}
