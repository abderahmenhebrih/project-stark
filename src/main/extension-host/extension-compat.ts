/**
 * Real compatibility analyzer (Step 9, main-side, pure).
 *
 * Classifies every installed extension as Compatible, Partially
 * compatible, or Unsupported from ACTUAL requirements — never invented
 * percentages:
 *
 * - extension kind (main vs browser-only)
 * - manifest contributions (which classes STARK supports)
 * - APIs encountered during activation (observed unsupported list)
 * - proposed APIs (explicit `proposed:` markers or engines mismatch)
 * - native modules (detectable `*.node` dependency hints)
 * - unsupported contribution classes (webviews, custom editors, debug,
 *   terminals/tasks beyond the safe subset)
 *
 * Declarative-only extensions (themes, grammars, snippets, languages,
 * configuration, commands, keybindings) classify Compatible without
 * requiring activation.
 */

export type CompatibilityLevel = 'compatible' | 'partial' | 'unsupported'

export interface CompatibilityInput {
  /** True when the manifest provides a Node `main` entrypoint. */
  readonly hasMain: boolean
  /** True when the manifest provides only a `browser` entrypoint. */
  readonly hasBrowserOnly: boolean
  /** Top-level `contributes` keys (bounded, e.g. `themes`, `webviews`). */
  readonly contributesKeys: readonly string[]
  /** Unsupported APIs observed during activation (bounded exact names). */
  readonly unsupportedApis: readonly string[]
  /** Proposed API markers observed (e.g. `proposed:terminalDataWriteEvent`). */
  readonly proposedApis: readonly string[]
  /** Whether a native `.node` binary was detected in the package. */
  readonly hasNativeModules: boolean
  /** Whether activation failed with a real (non-API) error. */
  readonly activationFailed: boolean
  /** The failure category when activationFailed (bounded, e.g. `timeout`). */
  readonly failureCode: string | null
}

export interface CompatibilityResult {
  readonly level: CompatibilityLevel
  /** Human-useful reasons (bounded count + length, no internals). */
  readonly reasons: readonly string[]
}

/** Declarative contribution classes needing no code execution. */
const DECLARATIVE_CONTRIBUTIONS: readonly string[] = [
  'themes',
  'iconThemes',
  'snippets',
  'languages',
  'configuration',
  'commands',
  'keybindings',
  'menus',
  'colors',
  'viewsContainers'
]

/** Contribution classes STARK marks Partially Compatible (honest limits). */
const PARTIAL_CONTRIBUTIONS: Record<string, string> = {
  // Grammar files are recognized and validated, but STARK has no
  // TextMate engine: highlighting follows built-in languages.
  grammars: 'Uses a grammar, which STARK highlights with built-in languages',
  webviews: 'Uses webviews, which STARK shows with limited support',
  customEditors: 'Uses a custom editor, which STARK shows with limited support',
  views: 'Contributes views, which STARK shows with limited support',
  taskDefinitions: 'Contributes tasks, which need approval in STARK',
  problemMatchers: 'Contributes problem matchers, which need approval in STARK'
}

/** Contribution classes STARK reports Unsupported (no silent faking). */
const UNSUPPORTED_CONTRIBUTIONS: Record<string, string> = {
  debuggers: 'Requires the debugger API, which STARK does not support',
  breakpoints: 'Requires the debugger API, which STARK does not support',
  terminal: 'Requires the full terminal API, which STARK only partly supports',
  notebooks: 'Requires the notebook API, which STARK does not support',
  authentication: 'Requires account authentication, which STARK does not support',
  comments: 'Requires the comments API, which STARK does not support',
  timeline: 'Requires the timeline API, which STARK does not support',
  fileSystemProviders: 'Requires a virtual filesystem, which STARK does not support',
  proposed: 'Requires proposed APIs, which STARK does not support'
}

const MAX_REASONS = 8
const MAX_REASON_LENGTH = 160

function pushReason(reasons: string[], reason: string): void {
  if (reasons.length >= MAX_REASONS) {
    return
  }
  reasons.push(reason.slice(0, MAX_REASON_LENGTH))
}

/** Pure compatibility classification (deterministic, bounded). */
export function analyzeCompatibility(input: CompatibilityInput): CompatibilityResult {
  const reasons: string[] = []
  // Kind gate first: browser-only with no Node main cannot run here.
  if (!input.hasMain && input.hasBrowserOnly) {
    return { level: 'unsupported', reasons: ['Browser extension host is unavailable'] }
  }
  if (!input.hasMain && !input.hasBrowserOnly) {
    // No executable entrypoint at all: purely declarative packages
    // (themes/grammars/snippets) classify below on their merits;
    // anything demanding execution runtimes without an entrypoint is
    // Unsupported.
    const executable = input.contributesKeys.some((key) => UNSUPPORTED_CONTRIBUTIONS[key] !== undefined)
    if (executable || input.unsupportedApis.length > 0) {
      return { level: 'unsupported', reasons: ['Extension has no supported entrypoint'] }
    }
  }
  if (input.hasNativeModules) {
    pushReason(reasons, 'Uses native modules, which STARK does not load')
    return { level: 'unsupported', reasons }
  }
  let level: CompatibilityLevel = 'compatible'
  for (const key of input.contributesKeys.slice(0, 32)) {
    if (DECLARATIVE_CONTRIBUTIONS.includes(key)) {
      continue
    }
    const partial = PARTIAL_CONTRIBUTIONS[key]
    if (partial !== undefined) {
      level = level === 'unsupported' ? level : 'partial'
      pushReason(reasons, partial)
      continue
    }
    const unsupported = UNSUPPORTED_CONTRIBUTIONS[key]
    if (unsupported !== undefined) {
      level = 'unsupported'
      pushReason(reasons, unsupported)
      continue
    }
    // Unknown future contribution classes: honest partial, never fake.
    level = level === 'unsupported' ? level : 'partial'
    pushReason(reasons, `Uses '${key.slice(0, 48)}', which STARK does not fully support`)
  }
  for (const api of input.unsupportedApis.slice(0, 16)) {
    if (typeof api !== 'string' || api === '') {
      continue
    }
    level = level === 'unsupported' ? level : 'partial'
    pushReason(reasons, `Requires unsupported API: ${api.slice(0, 96)}`)
  }
  for (const api of input.proposedApis.slice(0, 16)) {
    if (typeof api !== 'string' || api === '') {
      continue
    }
    level = level === 'unsupported' ? level : 'partial'
    pushReason(reasons, `Requires proposed API: ${api.slice(0, 96)}`)
  }
  if (input.activationFailed) {
    level = level === 'compatible' ? 'partial' : level
    pushReason(
      reasons,
      input.failureCode !== null && input.failureCode !== ''
        ? `Last activation failed (${input.failureCode.slice(0, 48)})`
        : 'Last activation failed'
    )
  }
  return { level, reasons }
}

/** Renderer-safe badge copy for a level (no percentages, ever). */
export function compatibilityLabel(level: CompatibilityLevel): string {
  if (level === 'compatible') {
    return 'Compatible'
  }
  if (level === 'partial') {
    return 'Partially compatible'
  }
  return 'Unsupported'
}
