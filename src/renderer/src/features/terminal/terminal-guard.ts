/**
 * Shared guard for ALL running human terminals (multi-terminal).
 *
 * Workspace switching consults this alongside the editor discard guard:
 * when any PTY session is running, switching requires one explicit user
 * confirmation ("Close the active terminal and switch projects?").
 * The flag lives in module scope: Explorer sets it from the live
 * session list, and every workspace-switch trigger reads it. The
 * registered kill handler terminates every owned terminal (not merely
 * the selected one) with bounded exact cleanup.
 */

export const TERMINAL_SWITCH_CONFIRM_MESSAGE = 'Close the active terminal and switch projects?'

let terminalActive = false
let killHandler: (() => Promise<void>) | null = null

/** Called by Explorer whenever the live running-terminal set changes. */
export function setTerminalActive(value: boolean): void {
  terminalActive = value
}

/** True while any PTY session is running for the current window. */
export function hasActiveTerminal(): boolean {
  return terminalActive
}

/** Explorer registers its bounded kill-all routine; workspace-switch flows invoke it on confirmed switch. */
export function registerTerminalKillHandler(handler: (() => Promise<void>) | null): void {
  killHandler = handler
}

/** Kills every owned terminal with bounded cleanup (no-op when none). */
export async function closeAllTerminalsForSwitch(): Promise<void> {
  if (!terminalActive) {
    return
  }
  const handler = killHandler
  if (handler === null) {
    return
  }
  await handler()
}

/**
 * Returns true when a workspace switch may proceed: no active
 * terminal, or the user confirmed closing it. Returns false when the
 * user declines (caller must stay on the current workspace) or when no
 * confirmation UI is available while a session runs.
 */
export function confirmCloseTerminalAndSwitch(confirm?: () => boolean): boolean {
  if (!terminalActive) {
    return true
  }
  if (confirm !== undefined) {
    return confirm()
  }
  const candidate = (globalThis as { confirm?: unknown }).confirm
  if (typeof candidate === 'function') {
    return (candidate as (message: string) => boolean)(TERMINAL_SWITCH_CONFIRM_MESSAGE)
  }
  return false
}
