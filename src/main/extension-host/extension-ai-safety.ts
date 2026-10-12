/**
 * AI agent safety boundary (main-side, pure, central definition).
 *
 * VS Code normally allows extensions to edit workspace files. STARK's
 * stronger invariant: AUTONOMOUS AI agent changes stay reviewable
 * (proposal → review → Accept). NORMAL user-triggered extension edits
 * (formatters, refactors, explicit user commands) use the standard
 * editor/workspace-edit flow without becoming AI transactions.
 *
 * The boundary is the ORIGIN of the edit, not the API used:
 * - `user-action`: a human invoked the command/palette/action just now.
 * - `autonomous-agent`: a background/chat agent edit routed through
 *   STARK composer without an immediate human gesture.
 */

export type EditOrigin = 'user-action' | 'autonomous-agent'

export interface EditProposal {
  readonly origin: EditOrigin
  readonly extensionId: string
  readonly editsCount: number
}

/**
 * Whether an edit proposal requires human Accept before applying.
 * Autonomous agent edits ALWAYS require review. User-action edits
 * (formatters/refactors the user just triggered) do not enter the AI
 * transaction pipeline.
 */
export function requiresHumanAccept(proposal: EditProposal): boolean {
  return proposal.origin === 'autonomous-agent'
}

/**
 * Classifies an edit origin from its trigger context (pure). Explicit
 * user gestures (command palette, save, format-on-demand) are
 * user-action; composer/chat-agent background flows are autonomous.
 */
export function classifyEditOrigin(trigger: string): EditOrigin {
  if (trigger === 'composer-agent' || trigger === 'chat-agent' || trigger === 'autonomous') {
    return 'autonomous-agent'
  }
  return 'user-action'
}
