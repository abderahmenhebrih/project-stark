/**
 * Demand-driven activation-event engine (Step 8, main-side, pure).
 *
 * Manifest `activationEvents` are parsed here as DATA ONLY and evaluated
 * only when the matching trigger actually occurs — there is no startup
 * sweep that blindly executes installed extensions. Supported stable
 * events:
 *
 * - `onLanguage:<id>` — a document with that language id opens
 * - `onCommand:<command>` — that command is invoked
 * - `workspaceContains:<pattern>` — the workspace root contains a match
 * - `onStartupFinished` — after startup completes (explicit only)
 *
 * The unrestricted `*` event NEVER auto-activates: such extensions
 * require explicit trust/manual activation. Unknown events are recorded
 * but never trigger execution.
 *
 * Bounds: at most EXTENSION_INSTALL_MAX_LISTED extensions scanned per
 * index build; at most 128 events per extension (manifest cap); event
 * strings capped at 256 chars (manifest cap). `workspaceContains`
 * evaluation is root-level bounded glob matching only (`*`/`?`
 * wildcards over root entry names, optional leading `**\/` stripped) —
 * never a recursive scan, never outside the workspace root.
 */

/** Maximum extensions scanned per index build (matches install list cap). */
export const ACTIVATION_INDEX_MAX_EXTENSIONS = 512

/** Maximum activation events indexed per extension (matches manifest cap). */
export const ACTIVATION_INDEX_MAX_EVENTS_PER_EXTENSION = 128

/** Maximum candidate ids returned per lookup (bounded, deterministic). */
export const ACTIVATION_INDEX_MAX_CANDIDATES = 128

export type ActivationEventKind =
  | 'onLanguage'
  | 'onCommand'
  | 'workspaceContains'
  | 'onStartupFinished'
  | 'star'
  | 'other'

export interface ParsedActivationEvent {
  readonly raw: string
  readonly kind: ActivationEventKind
  /** Trigger value (language id, command id, or glob pattern). Empty for star/startup/other. */
  readonly value: string
}

/**
 * Parses one raw activation-event string (pure). Overlong, empty, or
 * NUL-containing values become `other` (never trigger). Matching is
 * case-sensitive for values except language ids, which callers
 * normalize to lowercase before lookup.
 */
export function parseActivationEvent(raw: unknown): ParsedActivationEvent {
  if (typeof raw !== 'string' || raw === '' || raw.length > 256 || raw.includes('\0')) {
    return { raw: '', kind: 'other', value: '' }
  }
  if (raw === '*') {
    return { raw, kind: 'star', value: '' }
  }
  if (raw === 'onStartupFinished') {
    return { raw, kind: 'onStartupFinished', value: '' }
  }
  for (const prefix of ['onLanguage:', 'onCommand:', 'workspaceContains:'] as const) {
    if (raw.startsWith(prefix)) {
      const value = raw.slice(prefix.length)
      if (value === '' || value.length > 128 || value.includes('\0')) {
        return { raw, kind: 'other', value: '' }
      }
      const kind: ActivationEventKind =
        prefix === 'onLanguage:' ? 'onLanguage' : prefix === 'onCommand:' ? 'onCommand' : 'workspaceContains'
      return { raw, kind, value }
    }
  }
  return { raw, kind: 'other', value: '' }
}

export interface ActivationIndexEntry {
  readonly extensionId: string
  readonly activationEvents: readonly string[]
}

export interface ActivationIndex {
  /** Lowercase language id → sorted extension ids. */
  readonly byLanguage: ReadonlyMap<string, readonly string[]>
  /** Command id → sorted extension ids. */
  readonly byCommand: ReadonlyMap<string, readonly string[]>
  /** Extensions explicitly declaring onStartupFinished (sorted). */
  readonly startupFinished: readonly string[]
  /** Bounded (extensionId, pattern) pairs for workspaceContains. */
  readonly workspacePatterns: readonly { readonly extensionId: string; readonly pattern: string }[]
}

/**
 * Builds a lightweight activation index from installed manifests
 * (pure, bounded, deterministic). `*` events are intentionally
 * excluded from every bucket — they require explicit trust/manual
 * activation and never auto-run.
 */
export function buildActivationIndex(entries: readonly ActivationIndexEntry[]): ActivationIndex {
  const byLanguage = new Map<string, string[]>()
  const byCommand = new Map<string, string[]>()
  const startup = new Set<string>()
  const workspacePatterns: { extensionId: string; pattern: string }[] = []
  const scanned = entries.slice(0, ACTIVATION_INDEX_MAX_EXTENSIONS)
  for (const entry of scanned) {
    if (typeof entry.extensionId !== 'string' || entry.extensionId === '') {
      continue
    }
    const events = Array.isArray(entry.activationEvents)
      ? entry.activationEvents.slice(0, ACTIVATION_INDEX_MAX_EVENTS_PER_EXTENSION)
      : []
    const seen = new Set<string>()
    for (const raw of events) {
      const parsed = parseActivationEvent(raw)
      if (parsed.kind === 'star' || parsed.kind === 'other') {
        continue
      }
      if (parsed.kind === 'onStartupFinished') {
        startup.add(entry.extensionId)
        continue
      }
      if (parsed.kind === 'onLanguage') {
        const key = parsed.value.toLowerCase()
        if (key === '' || seen.has(`lang:${key}`)) {
          continue
        }
        seen.add(`lang:${key}`)
        const bucket = byLanguage.get(key) ?? []
        if (bucket.length < ACTIVATION_INDEX_MAX_CANDIDATES && !bucket.includes(entry.extensionId)) {
          bucket.push(entry.extensionId)
          byLanguage.set(key, bucket)
        }
        continue
      }
      if (parsed.kind === 'onCommand') {
        if (seen.has(`cmd:${parsed.value}`)) {
          continue
        }
        seen.add(`cmd:${parsed.value}`)
        const bucket = byCommand.get(parsed.value) ?? []
        if (bucket.length < ACTIVATION_INDEX_MAX_CANDIDATES && !bucket.includes(entry.extensionId)) {
          bucket.push(entry.extensionId)
          byCommand.set(parsed.value, bucket)
        }
        continue
      }
      // workspaceContains: one bounded pair per distinct pattern.
      if (seen.has(`ws:${parsed.value}`)) {
        continue
      }
      seen.add(`ws:${parsed.value}`)
      if (workspacePatterns.length < ACTIVATION_INDEX_MAX_CANDIDATES * 4) {
        workspacePatterns.push({ extensionId: entry.extensionId, pattern: parsed.value })
      }
    }
  }
  for (const bucket of byLanguage.values()) {
    bucket.sort()
  }
  for (const bucket of byCommand.values()) {
    bucket.sort()
  }
  return {
    byLanguage,
    byCommand,
    startupFinished: [...startup].sort().slice(0, ACTIVATION_INDEX_MAX_CANDIDATES),
    workspacePatterns
  }
}

/** Extensions to consider when a document of this language opens. */
export function extensionsForLanguage(index: ActivationIndex, languageId: string): readonly string[] {
  if (typeof languageId !== 'string' || languageId === '') {
    return []
  }
  return index.byLanguage.get(languageId.toLowerCase()) ?? []
}

/** Extensions to consider when this command is invoked. */
export function extensionsForCommand(index: ActivationIndex, commandId: string): readonly string[] {
  if (typeof commandId !== 'string' || commandId === '') {
    return []
  }
  return index.byCommand.get(commandId) ?? []
}

/** Extensions explicitly declaring onStartupFinished. */
export function extensionsForStartupFinished(index: ActivationIndex): readonly string[] {
  return index.startupFinished
}

function globToRegExp(glob: string): RegExp | null {
  if (glob === '' || glob.length > 128 || glob.includes('\0') || glob.includes('/')) {
    return null
  }
  let source = ''
  for (const char of glob) {
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
 * Matches one workspaceContains pattern against root-level entry names
 * (pure, bounded). A leading `**\/` prefix is stripped (root scope is
 * implicit); any other `/` fails closed. `*`/`?` wildcards only — no
 * character classes, no recursion. `rootEntries` must be the
 * workspace root's direct children (callers cap the listing).
 */
export function matchWorkspaceContainsPattern(pattern: string, rootEntries: readonly string[]): boolean {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > 128 || pattern.includes('\0')) {
    return false
  }
  let glob = pattern
  if (glob.startsWith('**/')) {
    glob = glob.slice(3)
  }
  if (glob === '' || glob.includes('/')) {
    return false
  }
  const expression = globToRegExp(glob)
  if (expression === null) {
    return false
  }
  const entries = rootEntries.slice(0, 1024)
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '') {
      continue
    }
    const base = entry.split('/').pop() ?? entry
    if (expression.test(base)) {
      return true
    }
  }
  return false
}

/**
 * Extensions whose workspaceContains pattern matches the given
 * root-level entries (pure, bounded, deterministic order).
 */
export function extensionsForWorkspace(
  index: ActivationIndex,
  rootEntries: readonly string[]
): readonly string[] {
  const out: string[] = []
  for (const { extensionId, pattern } of index.workspacePatterns) {
    if (out.length >= ACTIVATION_INDEX_MAX_CANDIDATES) {
      break
    }
    if (out.includes(extensionId)) {
      continue
    }
    if (matchWorkspaceContainsPattern(pattern, rootEntries)) {
      out.push(extensionId)
    }
  }
  return out.sort()
}
