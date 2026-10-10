/**
 * Contribution-point engine (Step 9, main-side, pure).
 *
 * Processes normalized `manifest.contributes` as DATA ONLY into typed,
 * bounded contribution sets. Purely declarative classes (languages,
 * grammars, snippets, themes, iconThemes, configuration, commands,
 * keybindings) never require extension activation. Executable classes
 * (views, webviews, debuggers, …) are reported for the compatibility
 * analyzer — never executed here.
 *
 * Every collection is capped; every string is length-checked; paths
 * are extension-owned relative paths only (no absolute, no traversal,
 * no backslashes). Nothing here reads extension files — path values
 * are validated shapes that loaders resolve under containment later.
 */

export const CONTRIB_MAX_LANGUAGES = 64
export const CONTRIB_MAX_GRAMMARS = 64
export const CONTRIB_MAX_SNIPPETS = 64
export const CONTRIB_MAX_THEMES = 32
export const CONTRIB_MAX_ICON_THEMES = 16
export const CONTRIB_MAX_COMMANDS = 256
export const CONTRIB_MAX_KEYBINDINGS = 256
export const CONTRIB_MAX_CONFIG_PROPS = 256
export const CONTRIB_MAX_STRING = 256
export const CONTRIB_MAX_PATH = 512
/** Maximum jsonValidation entries per extension (bounded). */
export const CONTRIB_MAX_JSON_VALIDATION = 32
/** Maximum fileMatch patterns per jsonValidation entry (bounded). */
export const CONTRIB_MAX_JSON_FILE_MATCH = 8

export interface LanguageContribution {
  readonly id: string
  readonly extensions: readonly string[]
  readonly aliases: readonly string[]
  readonly filenames: readonly string[]
  readonly firstLine: string | null
}

export interface GrammarContribution {
  readonly language: string
  readonly scopeName: string
  readonly path: string
}

export interface SnippetContribution {
  readonly language: string
  readonly path: string
}

export interface ThemeContribution {
  readonly id: string
  readonly label: string
  readonly path: string
  /** `vs`, `vs-dark`, or `hc-black` (editor theme kind). */
  readonly uiTheme: string
}

export interface IconThemeContribution {
  readonly id: string
  readonly label: string
  readonly path: string
}

export interface CommandContribution {
  readonly command: string
  readonly title: string
  readonly category: string | null
}

export interface KeybindingContribution {
  readonly command: string
  readonly key: string
  readonly when: string | null
}

export interface ConfigProperty {
  readonly type: string
  readonly default: string | number | boolean | null
  readonly description: string | null
  readonly enum: readonly string[] | null
}

/**
 * One validated `contributes.jsonValidation` entry (VS Code shape:
 * `{ fileMatch, url }`, where fileMatch is a glob or list of globs
 * and url is a schema URI — extension-local relative path or
 * `https://` remote). Data only; resolution (containment-checked
 * local reads, bounded main-owned remote fetch) happens in the
 * runtime service, never here.
 */
export interface JsonValidationContribution {
  readonly fileMatch: readonly string[]
  readonly url: string
}

export interface ParsedContributions {
  readonly languages: readonly LanguageContribution[]
  readonly grammars: readonly GrammarContribution[]
  readonly snippets: readonly SnippetContribution[]
  readonly themes: readonly ThemeContribution[]
  readonly iconThemes: readonly IconThemeContribution[]
  readonly commands: readonly CommandContribution[]
  readonly keybindings: readonly KeybindingContribution[]
  /** Configuration properties by `section.name` (safe control types only). */
  readonly configuration: ReadonlyMap<string, ConfigProperty>
  /** Validated JSON-schema mappings (`contributes.jsonValidation`). */
  readonly jsonValidation: readonly JsonValidationContribution[]
  /** Other (non-declarative) contribution keys present, for compat. */
  readonly otherKeys: readonly string[]
}

const COMMAND_ID = /^[A-Za-z0-9._-]+$/
const LANGUAGE_ID = /^[A-Za-z0-9_-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value === '' || value.length > maxLength || value.includes('\0')) {
    return null
  }
  return value
}

function boundedPath(value: unknown): string | null {
  const text = boundedText(value, CONTRIB_MAX_PATH)
  if (text === null || text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    return null
  }
  const trimmed = text.endsWith('/') ? text.slice(0, -1) : text
  if (trimmed === '') {
    return null
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '..') {
      return null
    }
  }
  if (!/\.(json|jsonc|tmLanguage|plist|yaml|yml)$/i.test(trimmed) && !trimmed.includes('.')) {
    return null
  }
  return trimmed
}

function stringList(value: unknown, maxEntries: number, maxLength: number): readonly string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const entry of value.slice(0, maxEntries)) {
    if (typeof entry === 'string' && entry !== '' && entry.length <= maxLength && !entry.includes('\0')) {
      out.push(entry)
    }
  }
  return out
}

function parseLanguages(value: unknown): readonly LanguageContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: LanguageContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_LANGUAGES)) {
    if (!isRecord(entry)) {
      continue
    }
    const id = boundedText(entry['id'], 64)
    if (id === null || !LANGUAGE_ID.test(id)) {
      continue
    }
    const firstLineRaw = entry['firstLine']
    out.push({
      id,
      extensions: stringList(entry['extensions'], 64, 32),
      aliases: stringList(entry['aliases'], 32, 64),
      filenames: stringList(entry['filenames'], 64, 128),
      firstLine:
        typeof firstLineRaw === 'string' && firstLineRaw !== '' && firstLineRaw.length <= 256
          ? firstLineRaw
          : null
    })
  }
  return out
}

function parseGrammars(value: unknown): readonly GrammarContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: GrammarContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_GRAMMARS)) {
    if (!isRecord(entry)) {
      continue
    }
    const language = boundedText(entry['language'], 64)
    const scopeName = boundedText(entry['scopeName'], 128)
    const path = boundedPath(entry['path'])
    if (language === null || scopeName === null || path === null) {
      continue
    }
    out.push({ language, scopeName, path })
  }
  return out
}

function parseSnippets(value: unknown): readonly SnippetContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: SnippetContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_SNIPPETS)) {
    if (!isRecord(entry)) {
      continue
    }
    const language = boundedText(entry['language'], 64)
    const path = boundedPath(entry['path'])
    if (language === null || path === null) {
      continue
    }
    out.push({ language, path })
  }
  return out
}

function parseThemes(value: unknown): readonly ThemeContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: ThemeContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_THEMES)) {
    if (!isRecord(entry)) {
      continue
    }
    const label = boundedText(entry['label'], CONTRIB_MAX_STRING)
    const path = boundedPath(entry['path'])
    if (label === null || path === null) {
      continue
    }
    const id = boundedText(entry['id'], CONTRIB_MAX_STRING) ?? label
    const uiThemeRaw = entry['uiTheme']
    const uiTheme =
      uiThemeRaw === 'vs' || uiThemeRaw === 'vs-dark' || uiThemeRaw === 'hc-black' ? uiThemeRaw : 'vs-dark'
    out.push({ id, label, path, uiTheme })
  }
  return out
}

function parseIconThemes(value: unknown): readonly IconThemeContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: IconThemeContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_ICON_THEMES)) {
    if (!isRecord(entry)) {
      continue
    }
    const label = boundedText(entry['label'], CONTRIB_MAX_STRING)
    const path = boundedPath(entry['path'])
    if (label === null || path === null) {
      continue
    }
    out.push({ id: boundedText(entry['id'], CONTRIB_MAX_STRING) ?? label, label, path })
  }
  return out
}

function parseCommands(value: unknown): readonly CommandContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: CommandContribution[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, CONTRIB_MAX_COMMANDS)) {
    if (!isRecord(entry)) {
      continue
    }
    const command = boundedText(entry['command'], 128)
    const title = boundedText(entry['title'], CONTRIB_MAX_STRING)
    if (command === null || !COMMAND_ID.test(command) || title === null || seen.has(command)) {
      continue
    }
    seen.add(command)
    const categoryRaw = entry['category']
    out.push({
      command,
      title,
      category:
        typeof categoryRaw === 'string' && categoryRaw !== '' && categoryRaw.length <= 128 ? categoryRaw : null
    })
  }
  return out
}

function parseKeybindings(value: unknown): readonly KeybindingContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: KeybindingContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_KEYBINDINGS)) {
    if (!isRecord(entry)) {
      continue
    }
    const command = boundedText(entry['command'], 128)
    const key = boundedText(entry['key'], 64)
    if (command === null || !COMMAND_ID.test(command) || key === null) {
      continue
    }
    const whenRaw = entry['when']
    out.push({
      command,
      key,
      when: typeof whenRaw === 'string' && whenRaw !== '' && whenRaw.length <= 256 ? whenRaw : null
    })
  }
  return out
}

function parseConfiguration(value: unknown): ReadonlyMap<string, ConfigProperty> {
  const out = new Map<string, ConfigProperty>()
  const sections: unknown[] = Array.isArray(value) ? value : isRecord(value) ? [value] : []
  for (const section of sections.slice(0, 8)) {
    if (!isRecord(section)) {
      continue
    }
    const properties = section['properties']
    if (!isRecord(properties)) {
      continue
    }
    for (const [key, prop] of Object.entries(properties)) {
      if (out.size >= CONTRIB_MAX_CONFIG_PROPS) {
        break
      }
      if (key === '' || key.length > 256 || key.includes('\0') || out.has(key)) {
        continue
      }
      if (!isRecord(prop)) {
        continue
      }
      const typeRaw = prop['type']
      const type =
        typeRaw === 'boolean' || typeRaw === 'string' || typeRaw === 'number' || typeRaw === 'integer'
          ? typeRaw
          : null
      if (type === null) {
        continue
      }
      const dflt = prop['default']
      const validDefault =
        dflt === undefined
          ? null
          : typeof dflt === 'string' || typeof dflt === 'number' || typeof dflt === 'boolean'
            ? dflt
            : null
      if (dflt !== undefined && validDefault === null && dflt !== null) {
        continue
      }
      const descriptionRaw = prop['description']
      const enumRaw = prop['enum']
      out.set(key, {
        type,
        default: validDefault,
        description:
          typeof descriptionRaw === 'string' && descriptionRaw.length <= 512 ? descriptionRaw : null,
        enum:
          Array.isArray(enumRaw) &&
          enumRaw.length <= 32 &&
          enumRaw.every((entry) => typeof entry === 'string' && entry.length <= 128)
            ? (enumRaw as string[])
            : null
      })
    }
  }
  return out
}

/**
 * Parses normalized `contributes` data into bounded contribution sets
 * (pure, never executes, never reads files). Unknown keys surface in
 * `otherKeys` for the compatibility analyzer.
 */
export function parseContributions(contributes: unknown): ParsedContributions {
  if (!isRecord(contributes)) {
    return {
      languages: [],
      grammars: [],
      snippets: [],
      themes: [],
      iconThemes: [],
      commands: [],
      keybindings: [],
      configuration: new Map(),
      jsonValidation: [],
      otherKeys: []
    }
  }
  const known = new Set([
    'languages',
    'grammars',
    'snippets',
    'themes',
    'iconThemes',
    'commands',
    'keybindings',
    'configuration',
    'jsonValidation'
  ])
  return {
    languages: parseLanguages(contributes['languages']),
    grammars: parseGrammars(contributes['grammars']),
    snippets: parseSnippets(contributes['snippets']),
    themes: parseThemes(contributes['themes']),
    iconThemes: parseIconThemes(contributes['iconThemes']),
    commands: parseCommands(contributes['commands']),
    keybindings: parseKeybindings(contributes['keybindings']),
    configuration: parseConfiguration(contributes['configuration']),
    jsonValidation: parseJsonValidation(contributes['jsonValidation']),
    otherKeys: Object.keys(contributes)
      .filter((key) => !known.has(key))
      .slice(0, 32)
  }
}

/**
 * Parses `contributes.jsonValidation` (VS Code: array of
 * `{ fileMatch: string | string[], url: string }`) into bounded
 * validated entries. fileMatch entries are glob/filename shapes
 * (bounded count + length, no NUL); url is an extension-local
 * relative path (`./schema.json`, `schemas/x.json`) or an
 * `https://` remote — anything else (http, data:, absolute paths,
 * traversal) is dropped entry-wise, never throws.
 */
export function parseJsonValidation(value: unknown): readonly JsonValidationContribution[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: JsonValidationContribution[] = []
  for (const entry of value.slice(0, CONTRIB_MAX_JSON_VALIDATION)) {
    if (!isRecord(entry)) {
      continue
    }
    const rawMatch = entry['fileMatch']
    const patterns: string[] = []
    const candidates = Array.isArray(rawMatch) ? rawMatch : [rawMatch]
    for (const candidate of candidates.slice(0, CONTRIB_MAX_JSON_FILE_MATCH)) {
      if (typeof candidate !== 'string' || candidate === '' || candidate.length > 256 || candidate.includes('\0')) {
        continue
      }
      patterns.push(candidate)
    }
    if (patterns.length === 0) {
      continue
    }
    const rawUrl = entry['url']
    if (typeof rawUrl !== 'string' || rawUrl === '' || rawUrl.length > 512 || rawUrl.includes('\0')) {
      continue
    }
    if (isRelativeSchemaUrl(rawUrl) || isHttpsSchemaUrl(rawUrl)) {
      out.push({ fileMatch: patterns, url: rawUrl })
    }
  }
  return out
}

/** Extension-local schema reference (relative path, no traversal, no drive/UNC). */
function isRelativeSchemaUrl(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return false
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) {
    return false
  }
  for (const segment of value.split('/')) {
    if (segment === '..') {
      return false
    }
  }
  return value !== '' && value.length <= CONTRIB_MAX_PATH
}

/** Remote schema reference (https only; auth, ports, queries handled at fetch). */
function isHttpsSchemaUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'https:'
}

export interface CapabilitySummary {
  /** Third-party code runs on activation (always true for main-entry extensions). */
  readonly runsCode: boolean
  /** Extension reads workspace files (declared engines/main heuristic). */
  readonly readsWorkspace: boolean
  /** Extension proposes workspace edits (formatter/codeAction/edit providers). */
  readonly proposesEdits: boolean
  /** Extension may start language servers (activation events + dependencies hint). */
  readonly mayStartLanguageServer: boolean
  /** Extension stores local data (globalState/workspaceState hint). */
  readonly storesData: boolean
}

/**
 * Derives an HONEST capability summary from manifest shape plus
 * runtime-observed registrations (never fabricated: every flag names
 * its evidence source in comments for reviewers).
 */
export function summarizeCapabilities(options: {
  readonly hasMain: boolean
  readonly activationEvents: readonly string[]
  readonly contributesCommands: number
  readonly observedProviders: readonly string[]
  readonly observedChildProcesses: number
}): CapabilitySummary {
  const providers = new Set(options.observedProviders)
  return {
    // A Node main entrypoint executes third-party code by definition.
    runsCode: options.hasMain,
    // Any executable extension with workspace-scoped activation or
    // registered providers can read what the host hands it.
    readsWorkspace: options.hasMain,
    // True only when an edit-producing provider was actually observed.
    proposesEdits:
      providers.has('documentFormatter') ||
      providers.has('rangeFormatter') ||
      providers.has('codeAction') ||
      providers.has('rename'),
    // True when a language-server-shaped trigger exists OR a child
    // process was actually spawned by this extension.
    mayStartLanguageServer:
      options.observedChildProcesses > 0 ||
      options.activationEvents.some(
        (event) => event.startsWith('onLanguage:') || event.startsWith('workspaceContains:')
      ),
    // Extensions commonly persist UI state; report true once storage
    // APIs are observed OR commands exist (conservative, documented).
    storesData: providers.has('storage') || options.contributesCommands > 0
  }
}
