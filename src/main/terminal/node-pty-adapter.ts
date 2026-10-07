import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-adapter'

/**
 * Production PtyFactory over the node-pty native module.
 *
 * The require is intentionally lazy and local to this module so the
 * native binary loads only inside Electron's main process — never in
 * ordinary system-Node unit tests (those inject a fake PtyFactory).
 * node-pty ships N-API prebuilds, so no ABI-specific rebuild is needed
 * for the current Electron version; a load failure surfaces as a
 * controlled terminal-unavailable error at spawn time.
 */
export function createNodePtyFactory(): PtyFactory {
  return {
    spawn: (file: string, args: readonly string[], options: PtySpawnOptions): PtyHandle => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require('node-pty') as {
        spawn: (
          file: string,
          args: string[] | string,
          opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
        ) => {
          readonly pid: number
          onData: (cb: (data: string) => void) => void
          onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
          write: (data: string) => void
          resize: (cols: number, rows: number) => void
          kill: (signal?: string) => void
        }
      }
      const proc = pty.spawn(file, [...args], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env
      })
      return {
        pid: proc.pid,
        onData: (callback) => proc.onData(callback),
        onExit: (callback) =>
          proc.onExit(({ exitCode, signal }) => {
            callback({
              exitCode: typeof exitCode === 'number' ? exitCode : null,
              signal: typeof signal === 'number' ? signal : null
            })
          }),
        write: (data) => proc.write(data),
        resize: (cols, rows) => proc.resize(cols, rows),
        kill: () => proc.kill()
      }
    }
  }
}
