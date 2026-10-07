/**
 * Shared terminal contracts (Stage 11).
 *
 * Plain TypeScript only — no Node.js or DOM APIs — so every process
 * (main, preload, renderer) can import these. The renderer never
 * chooses executables, cwd, or environment: creation carries only the
 * persisted workspace reference plus xterm dimensions.
 */

/** Public session handle returned to the renderer. PID stays internal. */
export interface TerminalSession {
  readonly id: string
  readonly workspaceId: number
  readonly shell: string
  readonly running: boolean
}

/** Renderer → main: explicit Start Terminal. No cwd, no shell, no env. */
export interface CreateTerminalRequest {
  readonly workspaceId: number
  readonly cols: number
  readonly rows: number
}

/** Renderer → main: human xterm keystrokes for one owned session. */
export interface TerminalWriteRequest {
  readonly sessionId: string
  readonly data: string
}

/** Renderer → main: FitAddon dimensions for one owned session. */
export interface TerminalResizeRequest {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/** Renderer → main: explicit Kill Terminal for one owned session. */
export interface TerminalKillRequest {
  readonly sessionId: string
}

/** Main → renderer: bounded PTY output chunk for the owning session. */
export interface TerminalDataEvent {
  readonly sessionId: string
  readonly data: string
}

/** Main → renderer: shell exit for the owning session, delivered once. */
export interface TerminalExitEvent {
  readonly sessionId: string
  readonly exitCode: number | null
  readonly signal: number | null
}

export type TerminalDataListener = (event: TerminalDataEvent) => void
export type TerminalExitListener = (event: TerminalExitEvent) => void

/**
 * Narrow renderer bridge for the human terminal.
 * No executable choice, no cwd choice, no environment maps,
 * no generic spawn/exec, no agent command-execution method.
 */
export interface TerminalApi {
  create: (request: CreateTerminalRequest) => Promise<TerminalSession>
  write: (request: TerminalWriteRequest) => Promise<void>
  resize: (request: TerminalResizeRequest) => Promise<void>
  kill: (request: TerminalKillRequest) => Promise<void>
  onData: (listener: TerminalDataListener) => () => void
  onExit: (listener: TerminalExitListener) => () => void
}
