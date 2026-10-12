/**
 * Demand-driven activation-event engine (Code OSS-compatible, main-side, pure).
 *
 * Manifest `activationEvents` are parsed here as DATA ONLY and evaluated
 * only when the matching trigger actually occurs — there is no startup
 * sweep that blindly executes installed extensions. Supported stable
 * events (Code OSS semantics where practical):
 *
 * - `onLanguage:<id>` — a document with that language id opens
 * - `onCommand:<command>` — that command is invoked
 * - `workspaceContains:<pattern>` — the workspace root contains a match
 * - `onStartupFinished` — after startup completes (explicit only)
 * - `onView:<viewId>`, `onUri`, `onFileSystem:<scheme>`,
 *   `onDebug[:type]`, `onCustomEditor:<viewType>`,
 *   `onWebviewPanel:<viewType>`, `onTerminalProfile:<id>`,
 *   `onTaskType:<type>`, `onNotebook:<type>`,
 *   `onAuthenticationRequest:<provider>`, `onSearch:<scheme>`,
 *   `onEditSession`, `onChatParticipant:<id>`
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
  | 'onView'
  | 'onUri'
  | 'onFileSystem'
  | 'onDebug'
  | 'onCustomEditor'
  | 'onWebviewPanel'
  | 'onTerminalProfile'
  | 'onTaskType'
  | 'onNotebook'
  | 'onAuthenticationRequest'
  | 'onSearch'
  | 'onEditSession'
  | 'onChatParticipant'
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
  if (raw === 'onUri') {
    return { raw, kind: 'onUri', value: '' }
  }
  if (raw === 'onEditSession') {
    return { raw, kind: 'onEditSession', value: '' }
  }
  for (const prefix of [
    'onLanguage:',
    'onCommand:',
    'workspaceContains:',
    'onView:',
    'onFileSystem:',
    'onDebug',
    'onCustomEditor:',
    'onWebviewPanel:',
    'onTerminalProfile:',
    'onTaskType:',
    'onNotebook:',
    'onAuthenticationRequest:',
    'onSearch:',
    'onChatParticipant:'
  ] as const) {
    if (raw === 'onDebug' && prefix === 'onDebug') {
      return { raw, kind: 'onDebug', value: '' }
    }
    if (raw.startsWith(prefix)) {
      const value = raw.slice(prefix.length)
      // onDebug allows bare `onDebug` plus `onDebug:<type>`.
      if (prefix === 'onDebug' && (value === '' || value === ':resolve' || value.startsWith(':'))) {
        return { raw, kind: 'onDebug', value: value.startsWith(':') ? value.slice(1) : '' }
      }
      if (value === '' || value.length > 128 || value.includes('\0')) {
        return { raw, kind: 'other', value: '' }
      }
      const kind: ActivationEventKind =
        prefix === 'onLanguage:'
          ? 'onLanguage'
          : prefix === 'onCommand:'
            ? 'onCommand'
            : prefix === 'workspaceContains:'
              ? 'workspaceContains'
              : prefix === 'onView:'
                ? 'onView'
                : prefix === 'onFileSystem:'
                  ? 'onFileSystem'
                  : prefix === 'onCustomEditor:'
                    ? 'onCustomEditor'
                    : prefix === 'onWebviewPanel:'
                      ? 'onWebviewPanel'
                      : prefix === 'onTerminalProfile:'
                        ? 'onTerminalProfile'
                        : prefix === 'onTaskType:'
                          ? 'onTaskType'
                          : prefix === 'onNotebook:'
                            ? 'onNotebook'
                            : prefix === 'onAuthenticationRequest:'
                              ? 'onAuthenticationRequest'
                              : prefix === 'onSearch:'
                                ? 'onSearch'
                                : 'onChatParticipant'
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
  /** View id → sorted extension ids (`onView`). */
  readonly byView: ReadonlyMap<string, readonly string[]>
  /** File-system scheme → sorted extension ids (`onFileSystem`). */
  readonly byFileSystem: ReadonlyMap<string, readonly string[]>
  /** Debug type → sorted extension ids (`onDebug`, '' = any). */
  readonly byDebug: ReadonlyMap<string, readonly string[]>
  /** Custom-editor viewType → sorted extension ids. */
  readonly byCustomEditor: ReadonlyMap<string, readonly string[]>
  /** Webview-panel viewType → sorted extension ids. */
  readonly byWebviewPanel: ReadonlyMap<string, readonly string[]>
  /** Terminal-profile id → sorted extension ids. */
  readonly byTerminalProfile: ReadonlyMap<string, readonly string[]>
  /** Task type → sorted extension ids. */
  readonly byTaskType: ReadonlyMap<string, readonly string[]>
  /** Notebook type → sorted extension ids. */
  readonly byNotebook: ReadonlyMap<string, readonly string[]>
  /** Auth provider id → sorted extension ids. */
  readonly byAuthentication: ReadonlyMap<string, readonly string[]>
  /** Chat participant id → sorted extension ids. */
  readonly byChatParticipant: ReadonlyMap<string, readonly string[]>
  /** Extensions declaring onUri (sorted). */
  readonly onUri: readonly string[]
  /** Extensions declaring onEditSession (sorted). */
  readonly onEditSession: readonly string[]
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
  const byView = new Map<string, string[]>()
  const byFileSystem = new Map<string, string[]>()
  const byDebug = new Map<string, string[]>()
  const byCustomEditor = new Map<string, string[]>()
  const byWebviewPanel = new Map<string, string[]>()
  const byTerminalProfile = new Map<string, string[]>()
  const byTaskType = new Map<string, string[]>()
  const byNotebook = new Map<string, string[]>()
  const byAuthentication = new Map<string, string[]>()
  const byChatParticipant = new Map<string, string[]>()
  const onUriSet = new Set<string>()
  const onEditSessionSet = new Set<string>()
  const startup = new Set<string>()
  const workspacePatterns: { extensionId: string; pattern: string }[] = []
  function addBucket(map: Map<string, string[]>, key: string, id: string): void {
    const bucket = map.get(key) ?? []
    if (bucket.length < ACTIVATION_INDEX_MAX_CANDIDATES && !bucket.includes(id)) {
      bucket.push(id)
      map.set(key, bucket)
    }
  }
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
      if (parsed.kind === 'onView') {
        if (seen.has(`view:${parsed.value}`)) continue
        seen.add(`view:${parsed.value}`)
        addBucket(byView, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onFileSystem' || parsed.kind === 'onSearch') {
        const key = parsed.kind === 'onSearch' ? `search:${parsed.value}` : parsed.value
        if (seen.has(key)) continue
        seen.add(key)
        addBucket(byFileSystem, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onDebug') {
        if (seen.has(`debug:${parsed.value}`)) continue
        seen.add(`debug:${parsed.value}`)
        addBucket(byDebug, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onCustomEditor') {
        if (seen.has(`ce:${parsed.value}`)) continue
        seen.add(`ce:${parsed.value}`)
        addBucket(byCustomEditor, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onWebviewPanel') {
        if (seen.has(`wp:${parsed.value}`)) continue
        seen.add(`wp:${parsed.value}`)
        addBucket(byWebviewPanel, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onTerminalProfile') {
        if (seen.has(`tp:${parsed.value}`)) continue
        seen.add(`tp:${parsed.value}`)
        addBucket(byTerminalProfile, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onTaskType') {
        if (seen.has(`tt:${parsed.value}`)) continue
        seen.add(`tt:${parsed.value}`)
        addBucket(byTaskType, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onNotebook') {
        if (seen.has(`nb:${parsed.value}`)) continue
        seen.add(`nb:${parsed.value}`)
        addBucket(byNotebook, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onAuthenticationRequest') {
        if (seen.has(`auth:${parsed.value}`)) continue
        seen.add(`auth:${parsed.value}`)
        addBucket(byAuthentication, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onChatParticipant') {
        if (seen.has(`chat:${parsed.value}`)) continue
        seen.add(`chat:${parsed.value}`)
        addBucket(byChatParticipant, parsed.value, entry.extensionId)
        continue
      }
      if (parsed.kind === 'onUri') {
        onUriSet.add(entry.extensionId)
        continue
      }
      if (parsed.kind === 'onEditSession') {
        onEditSessionSet.add(entry.extensionId)
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
  for (const bucket of [byView, byFileSystem, byDebug, byCustomEditor, byWebviewPanel, byTerminalProfile, byTaskType, byNotebook, byAuthentication, byChatParticipant]) {
    for (const b of bucket.values()) b.sort()
  }
  return {
    byLanguage,
    byCommand,
    startupFinished: [...startup].sort().slice(0, ACTIVATION_INDEX_MAX_CANDIDATES),
    workspacePatterns,
    byView,
    byFileSystem,
    byDebug,
    byCustomEditor,
    byWebviewPanel,
    byTerminalProfile,
    byTaskType,
    byNotebook,
    byAuthentication,
    byChatParticipant,
    onUri: [...onUriSet].sort().slice(0, ACTIVATION_INDEX_MAX_CANDIDATES),
    onEditSession: [...onEditSessionSet].sort().slice(0, ACTIVATION_INDEX_MAX_CANDIDATES)
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

/** Generic bucket lookup for Code OSS triggers (view, fs, debug, editors, panels, profiles, tasks, notebooks, auth, chat). */
export function extensionsForTrigger(
  index: ActivationIndex,
  bucket: 'byView' | 'byFileSystem' | 'byDebug' | 'byCustomEditor' | 'byWebviewPanel' | 'byTerminalProfile' | 'byTaskType' | 'byNotebook' | 'byAuthentication' | 'byChatParticipant',
  key: string
): readonly string[] {
  if (typeof key !== 'string' || key === '') {
    // `onDebug` bare form matches any debug trigger.
    if (bucket === 'byDebug' && key === '') {
      return index.byDebug.get('') ?? []
    }
    return []
  }
  return index[bucket].get(key) ?? []
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
