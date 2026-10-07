/**
 * Native PTY boundary (Stage 11).
 *
 * PtyAdapter isolates the node-pty binary so unit tests inject a fake
 * implementation and never require the native module in ordinary
 * system-Node suites. Real loading happens only in node-pty-adapter
 * inside Electron.
 */

export interface PtyExit {
  readonly exitCode: number | null
  readonly signal: number | null
}

export interface PtySpawnOptions {
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

/** Minimal handle over one native pseudoterminal instance. */
export interface PtyHandle {
  /** OS pid when exposed by the backend; otherwise undefined. */
  readonly pid?: number
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (exit: PtyExit) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

/** Factory that spawns one native PTY for a main-chosen shell. */
export interface PtyFactory {
  spawn: (file: string, args: readonly string[], options: PtySpawnOptions) => PtyHandle
}

/**
 * Splits PTY output into bounded IPC payloads (UTF-8 byte budget).
 * Main acts as a streaming bridge: huge PTY chunks are forwarded as
 * sequential bounded events, never accumulated into one history buffer.
 */
export function splitOutputForIpc(data: string, maxBytes: number): string[] {
  if (data === '' || maxBytes <= 0) {
    return data === '' ? [] : [data]
  }
  if (Buffer.byteLength(data, 'utf8') <= maxBytes) {
    return [data]
  }
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of data) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (currentBytes + charBytes > maxBytes && current !== '') {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    // A single char larger than the budget still forwards alone.
    current += char
    currentBytes += charBytes
  }
  if (current !== '') {
    chunks.push(current)
  }
  return chunks
}
