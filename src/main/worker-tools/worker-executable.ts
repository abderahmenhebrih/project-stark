import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { TextEncoder } from 'node:util'
import { MAX_EXECUTABLE_PATH_BYTES, MAX_EXECUTABLE_PATH_ENTRIES } from './worker-terminal-limits'

const encoder = new TextEncoder()

export interface ExecutableResolution {
  /** Absolute resolved executable path, or null when unresolvable. */
  readonly absolutePath: string | null
  /** True when the PATH itself exceeded sanitization bounds. */
  readonly pathRejected: boolean
}

function splitPathList(rawPath: string): string[] {
  return rawPath.split(delimiter)
}

/**
 * Resolves one validated bare program through a bounded sanitized PATH
 * search. Never consults the current working directory or the Workspace
 * root for executables: only absolute paths derived from PATH entries
 * are candidates, each probed for execute permission. Windows PATHEXT
 * suffixes are honored per entry. Returns null (safe tool failure)
 * when nothing resolves.
 *
 * `overrides` exists for deterministic tests only; production always
 * uses the live process environment.
 */
export async function resolveWorkerExecutable(
  program: string,
  overrides?: { readonly pathEnv?: string; readonly pathextEnv?: string; readonly isWindows?: boolean }
): Promise<ExecutableResolution> {
  const pathEnv = overrides?.pathEnv ?? process.env['PATH'] ?? ''
  const windows = overrides?.isWindows ?? process.platform === 'win32'
  if (encoder.encode(pathEnv).byteLength > MAX_EXECUTABLE_PATH_BYTES) {
    return { absolutePath: null, pathRejected: true }
  }
  const entries = splitPathList(pathEnv).filter((entry) => entry !== '')
  if (entries.length === 0 || entries.length > MAX_EXECUTABLE_PATH_ENTRIES) {
    return { absolutePath: null, pathRejected: true }
  }
  const extensions: readonly string[] =
    windows
      ? (overrides?.pathextEnv ?? process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
      : ['']
  const candidates: string[] = []
  for (const entry of entries.slice(0, MAX_EXECUTABLE_PATH_ENTRIES)) {
    if (windows) {
      const lowered = program.toLowerCase()
      const hasKnownSuffix = extensions.some((extension) => lowered.endsWith(extension.toLowerCase()))
      if (hasKnownSuffix) {
        candidates.push(join(entry, program))
      } else {
        for (const extension of extensions) {
          candidates.push(join(entry, `${program}${extension}`))
        }
      }
    } else {
      candidates.push(join(entry, program))
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return { absolutePath: candidate, pathRejected: false }
    } catch {
      // Try the next candidate.
    }
  }
  return { absolutePath: null, pathRejected: false }
}
