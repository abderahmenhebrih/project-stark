/**
 * Shell selection policy (Stage 11).
 *
 * The renderer NEVER sends an executable: the main process chooses a
 * safe platform default. Pure data — no spawning here — so the policy
 * is unit-testable without the native PTY binary.
 */

export interface SelectedShell {
  /** Executable launched directly by node-pty (never renderer-chosen). */
  readonly file: string
  /** Deterministic args for the selected shell. */
  readonly args: readonly string[]
  /** Short human label for the terminal header (e.g. PowerShell). */
  readonly label: string
}

/**
 * Selects the interactive shell for the given platform.
 * Windows uses powershell.exe with -NoLogo; macOS uses /bin/zsh;
 * Linux prefers /bin/bash with /bin/sh as fallback.
 */
export function selectShell(platform: NodeJS.Platform = process.platform): SelectedShell {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
  }
  if (platform === 'darwin') {
    return { file: '/bin/zsh', args: [], label: 'zsh' }
  }
  return { file: '/bin/bash', args: [], label: 'bash' }
}

/** Fallback shell when the preferred Linux shell is unavailable. */
export function fallbackShell(): SelectedShell {
  return { file: '/bin/sh', args: [], label: 'sh' }
}
