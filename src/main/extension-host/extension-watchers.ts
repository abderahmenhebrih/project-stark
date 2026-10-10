import { statSync, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Main-owned bounded file-watcher service (Step 8).
 *
 * Extensions declare `createFileSystemWatcher(pattern)` in the host;
 * the host notifies main (WATCHER_REGISTER) and THIS service watches
 * the workspace root, debounces events, matches them against each
 * registered pattern, and routes matches back as WATCHER_EVENT
 * messages. Workspace-contained patterns only; no watching arbitrary
 * filesystem roots.
 *
 * Bounds: 32 watchers per extension, 256 globally, 150ms debounce
 * per (watcher, path), at most 64 watched directories, patterns
 * capped at 256 chars. Watchers are root-scoped: `*` never crosses
 * `/`, `**\/` matches any depth. Disposal is exact (per watcher id,
 * per owner) — never broad.
 */

/** Maximum watchers per extension. */
export const EXTENSION_WATCHER_MAX_PER_EXTENSION = 32

/** Maximum watchers globally. */
export const EXTENSION_WATCHER_MAX_TOTAL = 256

/** Debounce per (watcher, path) in milliseconds. */
export const EXTENSION_WATCHER_DEBOUNCE_MS = 150

/** Maximum directories watched (recursive fallback cap). */
export const EXTENSION_WATCHER_MAX_DIRS = 64

/** Maximum pattern length. */
export const EXTENSION_WATCHER_MAX_PATTERN = 256

export type WatcherEventKind = 'create' | 'change' | 'delete'

export interface WatcherRegistration {
  readonly id: number
  readonly owner: string
  readonly pattern: string
  readonly hostWatcherId: number
}

export interface WatcherDispatch {
  readonly hostWatcherId: number
  readonly owner: string
  readonly kind: WatcherEventKind
  readonly uri: string
}

export interface ExtensionWatcherServiceOptions {
  /** Current workspace root (absolute) or null when none is open. */
  readonly workspaceRootProvider: () => string | null
  readonly debounceMs?: number
}

/**
 * Validates a watcher pattern is workspace-contained (pure): no
 * absolute paths, drive letters, backslashes, NUL, or `..` segments.
 */
export function validatedWatcherPattern(pattern: unknown): string {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > EXTENSION_WATCHER_MAX_PATTERN) {
    throw new Error('File watcher pattern is not valid.')
  }
  if (pattern.includes('\0') || pattern.includes('\\') || pattern.startsWith('/')) {
    throw new Error('File watcher pattern escapes the workspace.')
  }
  if (/^[A-Za-z]:/.test(pattern)) {
    throw new Error('File watcher pattern escapes the workspace.')
  }
  for (const segment of pattern.split('/')) {
    if (segment === '..') {
      throw new Error('File watcher pattern escapes the workspace.')
    }
  }
  return pattern
}

function segmentToRegExp(segment: string): RegExp | null {
  let source = ''
  for (const char of segment) {
    if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if ('+()|.^$[]{}\\'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  try {
    return new RegExp(`^${source}$`)
  } catch {
    return null
  }
}

/**
 * Matches a watcher pattern against a workspace-relative path
 * (pure, bounded). `**\/` consumes any depth (including none); `*`
 * never crosses `/`. Both pattern and path use forward slashes.
 */
export function matchWatcherPattern(pattern: string, relativePath: string): boolean {
  if (typeof pattern !== 'string' || pattern === '' || typeof relativePath !== 'string' || relativePath === '') {
    return false
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.includes('..')) {
    return false
  }
  const patternSegments = pattern.split('/')
  const pathSegments = normalized.split('/')
  return matchSegments(patternSegments, pathSegments)
}

function matchSegments(patternSegments: readonly string[], pathSegments: readonly string[]): boolean {
  if (patternSegments.length === 0) {
    return pathSegments.length === 0
  }
  const [head, ...rest] = patternSegments as [string, ...string[]]
  if (head === '**') {
    for (let skip = 0; skip <= pathSegments.length; skip += 1) {
      if (matchSegments(rest, pathSegments.slice(skip))) {
        return true
      }
    }
    return false
  }
  if (pathSegments.length === 0) {
    return false
  }
  const expression = segmentToRegExp(head)
  if (expression === null || !expression.test(pathSegments[0] as string)) {
    return false
  }
  return matchSegments(rest, pathSegments.slice(1))
}

export class ExtensionWatcherService {
  private readonly workspaceRootProvider: () => string | null
  private readonly debounceMs: number
  private readonly registrations = new Map<number, WatcherRegistration>()
  private readonly lastDispatch = new Map<string, number>()
  private readonly watchers: FSWatcher[] = []
  private watchedRoot: string | null = null
  private nextId = 1
  private dispatch: ((event: WatcherDispatch) => void) | null = null

  constructor(options: ExtensionWatcherServiceOptions) {
    this.workspaceRootProvider = options.workspaceRootProvider
    this.debounceMs = options.debounceMs ?? EXTENSION_WATCHER_DEBOUNCE_MS
  }

  /** Routes matches to the host (set once by the runtime service). */
  setDispatchListener(listener: (event: WatcherDispatch) => void): void {
    this.dispatch = listener
  }

  /** Active registrations (bounded copy, no handles). */
  listRegistrations(): readonly WatcherRegistration[] {
    return [...this.registrations.values()].slice(0, EXTENSION_WATCHER_MAX_TOTAL)
  }

  /**
   * Registers one workspace-contained pattern for an extension.
   * Returns the main-side registration id. Ensures the root watch
   * is running (best-effort: a missing workspace root still
   * registers; events flow once a root exists).
   */
  register(owner: string, pattern: string, hostWatcherId: number): WatcherRegistration {
    if (typeof owner !== 'string' || owner === '') {
      throw new Error('Watcher owner is not valid.')
    }
    if (!Number.isInteger(hostWatcherId) || hostWatcherId < 0) {
      throw new Error('Watcher id is not valid.')
    }
    const validated = validatedWatcherPattern(pattern)
    const owned = [...this.registrations.values()].filter((entry) => entry.owner === owner).length
    if (owned >= EXTENSION_WATCHER_MAX_PER_EXTENSION) {
      throw new Error('Too many file watchers.')
    }
    if (this.registrations.size >= EXTENSION_WATCHER_MAX_TOTAL) {
      throw new Error('Too many file watchers.')
    }
    const registration: WatcherRegistration = { id: this.nextId++, owner, pattern: validated, hostWatcherId }
    this.registrations.set(registration.id, registration)
    this.ensureWatching()
    return registration
  }

  /** Removes one registration (exact id). Returns true when removed. */
  unregister(id: number): boolean {
    return this.registrations.delete(id)
  }

  /** Removes every registration for one owner (exact-owner cleanup). */
  unregisterOwner(owner: string): void {
    for (const [id, registration] of [...this.registrations]) {
      if (registration.owner === owner) {
        this.registrations.delete(id)
      }
    }
    if (this.registrations.size === 0) {
      this.stopWatching()
    }
  }

  /** Stops all watches (shutdown/test teardown). */
  dispose(): void {
    this.stopWatching()
    this.registrations.clear()
    this.lastDispatch.clear()
  }

  private ensureWatching(): void {
    const root = this.workspaceRootProvider()
    if (root === null) {
      return
    }
    const resolved = resolve(root)
    if (this.watchedRoot === resolved && this.watchers.length > 0) {
      return
    }
    this.stopWatching()
    try {
      if (statSync(resolved).isDirectory() !== true) {
        return
      }
    } catch {
      return
    }
    try {
      const watcher = watch(resolved, { recursive: true }, (eventType, filename) => {
        this.onFsEvent(resolved, eventType, filename)
      })
      watcher.on('error', () => {
        // Watch failures degrade to no events (offline-safe).
      })
      this.watchers.push(watcher)
      this.watchedRoot = resolved
    } catch {
      // Best effort: patterns stay registered for a later root.
    }
  }

  private stopWatching(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // Best effort.
      }
    }
    this.watchers.length = 0
    this.watchedRoot = null
  }

  private onFsEvent(root: string, eventType: string, filename: string | Buffer | null): void {
    if (typeof filename !== 'string' || filename === '') {
      return
    }
    if (this.registrations.size === 0) {
      return
    }
    const normalized = filename.replace(/\\/g, '/')
    if (normalized.length > 1024) {
      return
    }
    const kind: WatcherEventKind = eventType === 'rename' ? 'create' : 'change'
    const now = Date.now()
    for (const registration of this.registrations.values()) {
      if (!matchWatcherPattern(registration.pattern, normalized)) {
        continue
      }
      const debounceKey = `${registration.id}:${normalized}`
      const last = this.lastDispatch.get(debounceKey) ?? 0
      if (now - last < this.debounceMs) {
        continue
      }
      this.lastDispatch.set(debounceKey, now)
      if (this.lastDispatch.size > 4096) {
        const oldest = [...this.lastDispatch.keys()].slice(0, 1024)
        for (const key of oldest) {
          this.lastDispatch.delete(key)
        }
      }
      this.dispatch?.({
        hostWatcherId: registration.hostWatcherId,
        owner: registration.owner,
        kind,
        uri: `file:${join(root, normalized).replace(/\\/g, '/')}`
      })
    }
  }
}
