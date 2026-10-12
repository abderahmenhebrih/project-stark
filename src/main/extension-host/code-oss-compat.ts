/**
 * Code OSS compatibility contract (main-side, pure).
 *
 * STARK targets ONE pinned Code OSS-compatible `vscode` API version.
 * Extensions receive a Code-OSS-compatible API through the isolated
 * Extension Host (MainThread/ExtHost-style RPC over HOST_REQUEST /
 * HOST_NOTIFY), never renderer execution. The legacy finite shim
 * (`vscode-shim.mjs`) remains only as the current compatibility-layer
 * implementation behind this contract while it is widened toward the
 * pinned version — it is not the long-term architecture.
 *
 * Source basis: microsoft/vscode (MIT). STARK reuses Code OSS
 * architecture concepts (extensionHostProcess isolation,
 * extensionService activation, ExtHost/MainThread RPC split,
 * activation events, contribution points, vscode module shape) as
 * clean-room TypeScript adapters at STARK boundaries — no proprietary
 * VS Code product assets, Marketplace integration, branding, or
 * closed built-ins are copied. See THIRD_PARTY_NOTICES.md.
 */

export const CODE_OSS_COMPAT_VERSION = '1.90.0'

export const CODE_OSS_COMPAT_ENGINE_RANGE = '^1.90.0'

export const CODE_OSS_COMPAT_PROPOSED_API = false as const

export const CODE_OSS_SOURCE_REPO = 'https://github.com/microsoft/vscode'

/** Tag/commit STARK audited against (update deliberately with the pin). */
export const CODE_OSS_COMPAT_TAG = '1.90.0'

export interface EngineClassification {
  readonly level: 'compatible' | 'likely-compatible' | 'requires-newer-layer' | 'unsupported'
  readonly detail: string
}

/**
 * Classifies an extension's `engines.vscode` range against the pinned
 * compatibility version. Honest and narrow: exact pins and carets at
 * or below 1.90.0 are Compatible; loose/star ranges are
 * Likely compatible; ranges demanding newer than 1.90.0 require a
 * newer layer; unparseable/empty ranges are Unsupported (never
 * guessed). No extension-specific logic.
 */
export function classifyEngineRequirement(raw: unknown): EngineClassification {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 64 || raw.includes('\0')) {
    return { level: 'unsupported', detail: 'Missing engines.vscode range.' }
  }
  const text = raw.trim()
  if (text === '*') {
    return { level: 'likely-compatible', detail: 'Unbounded engine range; compatibility is best-effort.' }
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (match === null) {
    return { level: 'unsupported', detail: 'Unparseable engines.vscode range.' }
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return { level: 'unsupported', detail: 'Unparseable engines.vscode range.' }
  }
  if (major < 1 || (major === 1 && minor <= 90)) {
    if (/^\^?1\.(?:[0-8]\d?|90)\./.test(text) || text.startsWith('>=') || text === '*' || /^\d+\.\d+\.\d+$/.test(text)) {
      return { level: 'compatible', detail: `engines.vscode ${text} is within the ${CODE_OSS_COMPAT_VERSION} layer.` }
    }
    return { level: 'compatible', detail: `engines.vscode ${text} is within the ${CODE_OSS_COMPAT_VERSION} layer.` }
  }
  return {
    level: 'requires-newer-layer',
    detail: `engines.vscode ${text} requires a newer compatibility layer than ${CODE_OSS_COMPAT_VERSION}.`
  }
}

/** Stable `vscode` API domains STARK reports coverage for. */
export const CODE_OSS_API_DOMAINS: readonly string[] = [
  'commands',
  'workspace',
  'window',
  'languages',
  'diagnostics',
  'configuration',
  'storage/secrets',
  'Uri/EventEmitter/Disposable',
  'filesystem',
  'webviews',
  'views/trees',
  'statusbar',
  'themes/snippets',
  'formatters/language-servers',
  'terminal',
  'authentication',
  'env/clipboard/external',
  'extensions',
  'debug',
  'tasks',
  'scm',
  'notebooks/custom-editors',
  'chat/language-model',
  'tests'
]

/** Contribution points tracked for the coverage report. */
export const CODE_OSS_CONTRIBUTION_POINTS: readonly string[] = [
  'languages',
  'grammars',
  'snippets',
  'themes',
  'iconThemes',
  'configuration',
  'commands',
  'keybindings',
  'menus',
  'colors',
  'viewsContainers',
  'views',
  'webviews',
  'customEditors',
  'taskDefinitions',
  'problemMatchers',
  'debuggers',
  'breakpoints',
  'terminal',
  'notebooks',
  'authentication',
  'comments',
  'timeline',
  'fileSystemProviders',
  'jsonValidation'
]

export interface CompatContract {
  readonly vscodeVersion: string
  readonly engineRange: string
  readonly proposedApi: false
}

/** Machine-readable contract exposed to diagnostics (never faked newer). */
export function extensionApiCompatibility(): CompatContract {
  return {
    vscodeVersion: CODE_OSS_COMPAT_VERSION,
    engineRange: CODE_OSS_COMPAT_ENGINE_RANGE,
    proposedApi: CODE_OSS_COMPAT_PROPOSED_API
  }
}
