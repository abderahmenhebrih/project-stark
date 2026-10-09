import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export type TreeSpawnFn = typeof nodeSpawn
export type ProcessKillFn = (pid: number, signal: NodeJS.Signals) => void

function isExactPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Builds the exact Windows tree-termination argv for one live PID.
 * Only `/PID <exact-pid> /T /F` forms are ever produced — never `/IM`,
 * never image names, never broad filters. Throws for anything that
 * is not an exact positive-integer PID.
 */
export function buildTaskkillArgs(pid: number): readonly string[] {
  if (!isExactPid(pid)) {
    throw new Error('refusing to terminate a non-exact process id')
  }
  return ['/PID', String(pid), '/T', '/F']
}

export interface KillTreeOptions {
  readonly platform?: NodeJS.Platform
  readonly spawnImpl?: TreeSpawnFn
  readonly processKill?: ProcessKillFn
}

/**
 * Terminates exactly the spawned process tree. POSIX runtimes spawn
 * detached (their own process group), so signalling the negative PID
 * reaches the whole tree; Windows uses `taskkill /PID <exact-pid>
 * /T` against the live PID only. Only ever targets the live
 * handle/PID handed to it — never a name, never a scan, never a
 * global kill. Best effort; callers stay bounded regardless.
 */
export function killProcessTree(
  child: Pick<ChildProcess, 'kill' | 'pid'>,
  options?: KillTreeOptions
): void {
  const platform = options?.platform ?? process.platform
  const spawnImpl = options?.spawnImpl ?? nodeSpawn
  const processKill = options?.processKill ?? process.kill.bind(process)
  if (platform === 'win32' && typeof child.pid === 'number') {
    try {
      const killer = spawnImpl('taskkill', [...buildTaskkillArgs(child.pid)], {
        shell: false,
        detached: false,
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Best effort.
        }
      })
      killer.unref?.()
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // Best effort.
      }
    }
    return
  }
  if (typeof child.pid === 'number') {
    try {
      processKill(-child.pid, 'SIGTERM')
      return
    } catch {
      // Fall through to signalling the exact handle only.
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // Best effort.
  }
}
