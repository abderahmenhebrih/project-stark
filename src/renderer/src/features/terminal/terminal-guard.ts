/**
 * Single shared guard for the active human terminal.
 *
 * Workspace switching consults this alongside the editor discard guard:
 * when a PTY session is running, switching requires explicit user
 * confirmation ("Close the active terminal and switch projects?").
 * The flag lives in module scope: TerminalPanel sets it, and every
 * workspace-switch trigger reads it.
 */

export const TERMINAL_SWITCH_CONFIRM_MESSAGE = 'Close the active terminal and switch projects?'

let terminalActive = false
let killHandler: (() => Promise<void>) | null = null

/** Called by TerminalPanel whenever its running state changes. */
export function setTerminalActive(value: boolean): void {
  terminalActive = value
}

/** True while a PTY session is running for the current window. */
export function hasActiveTerminal(): boolean {
  return terminalActive
}

/** TerminalPanel registers its bounded kill routine; WorkspaceSection invokes it on confirmed switch. */
export function registerTerminalKillHandler(handler: (() => Promise<void>) | null): void {
  killHandler = handler
}

/** Kills the active terminal with bounded cleanup (no-op when none). */
export async function closeActiveTerminalForSwitch(): Promise<void> {
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
