/**
 * STARK Monaco theme: obsidian surfaces with a restrained neon-lime
 * accent, aligned with the application design tokens (see styles/
 * tokens.css). Pure data plus a narrow registration seam so token
 * choices stay unit-testable without a Monaco implementation.
 */

export const STARK_EDITOR_THEME_NAME = 'stark-obsidian'

/** Minimal structural surface of the Monaco editor API used here. */
export interface MonacoThemeApi {
  editor: {
    defineTheme: (name: string, theme: StarkEditorTheme) => void
    setTheme: (name: string) => void
  }
}

export interface StarkTokenRule {
  readonly token: string
  readonly foreground: string
  readonly fontStyle?: string
}

export interface StarkEditorTheme {
  readonly base: 'vs' | 'vs-dark'
  readonly inherit: boolean
  // Mutable containers on purpose: this shape must satisfy Monaco's
  // IStandaloneThemeData so registration typechecks directly.
  readonly rules: StarkTokenRule[]
  readonly encodedTokensColors?: string[]
  readonly colors: Record<string, string>
}

/**
 * Semantic token types styled by stark-obsidian. Monaco resolves
 * semantic tokens through the same theme trie as lexical tokens
 * (`getTokenStyleMetadata` matches `type.modifiers` against `rules`),
 * so these entries improve coloring when a semantic provider (LSP or
 * extension) is present and are harmless when it is absent — lexical
 * Monarch coloring always works on its own.
 */
export const STARK_SEMANTIC_TOKEN_TYPES: readonly string[] = [
  'class',
  'interface',
  'enum',
  'struct',
  'type',
  'typeParameter',
  'function',
  'method',
  'property',
  'parameter',
  'variable',
  'namespace',
  'decorator',
  'annotation',
  'macro',
  'constant'
]

/** Theme data: near-black background, lime reserved for caret/accents. */
export function starkEditorTheme(): StarkEditorTheme {  return {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Comments: muted gray-green, de-emphasized but legible.
      { token: 'comment', foreground: '5f6f62', fontStyle: 'italic' },
      { token: 'comment.doc', foreground: '5f6f62', fontStyle: 'italic' },
      { token: 'comment.content', foreground: '5f6f62' },
      // Keywords: readable STARK magenta-family pink (never lime:
      // lime stays UI/action branding for caret and selections).
      { token: 'keyword', foreground: 'ff7ab8' },
      { token: 'keyword.json', foreground: 'ff7ab8' },
      { token: 'keyword.flow', foreground: 'ff7ab8' },
      { token: 'keyword.other', foreground: 'ff7ab8' },
      // Strings: soft readable green.
      { token: 'string', foreground: '9ce8a0' },
      // JSON keys read as properties (muted blue-gray) so
      // package.json keys/values/booleans never collapse to white.
      { token: 'string.key.json', foreground: '9db8c7' },
      { token: 'string.value.json', foreground: '9ce8a0' },
      { token: 'string.escape', foreground: 'e3c878' },
      { token: 'string.invalid', foreground: 'f87171' },
      // Markdown links/targets: cyan + underline, distinct from
      // plain strings and body text.
      { token: 'string.link', foreground: '7cc7ff', fontStyle: 'underline' },
      { token: 'string.target', foreground: '7cc7ff', fontStyle: 'underline' },
      // Numbers/constants: warm amber accent.
      { token: 'number', foreground: 'fbbf24' },
      { token: 'number.float', foreground: 'fbbf24' },
      { token: 'number.hex', foreground: 'fbbf24' },
      { token: 'number.octal', foreground: 'fbbf24' },
      { token: 'number.binary', foreground: 'fbbf24' },
      { token: 'constant', foreground: 'fbbf24' },
      // Types/classes/interfaces: clear cyan-blue. These entries
      // serve both Monarch lexical types (`type`, `type.identifier`)
      // and semantic token types (`class`, `interface`, `enum`, …).
      { token: 'type', foreground: '7cc7ff' },
      { token: 'type.identifier', foreground: '7cc7ff' },
      { token: 'class', foreground: '7cc7ff' },
      { token: 'interface', foreground: '7cc7ff' },
      { token: 'enum', foreground: '7cc7ff' },
      { token: 'struct', foreground: '7cc7ff' },
      { token: 'typeParameter', foreground: '7cc7ff' },
      { token: 'namespace', foreground: '7cc7ff' },
      // Functions/calls: warm sand, distinct from amber numbers.
      // Covers Monarch `function` scopes and semantic
      // `function`/`method`/`macro` tokens.
      { token: 'function', foreground: 'e3c878' },
      { token: 'method', foreground: 'e3c878' },
      { token: 'macro', foreground: 'e3c878' },
      // Properties/attributes: muted blue-gray, subtle contrast
      // against the default variable foreground. Covers Monarch
      // `property`/`key` and semantic `property`.
      { token: 'property', foreground: '9db8c7' },
      { token: 'key', foreground: '9db8c7' },
      // Variables/identifiers: soft off-white default.
      { token: 'identifier', foreground: 'e9f1ea' },
      { token: 'variable', foreground: 'e9f1ea' },
      // Parameters read lavender-italic: distinct from plain
      // variables without adding another neon hue.
      { token: 'parameter', foreground: 'd6c9f5', fontStyle: 'italic' },
      { token: 'variable.parameter', foreground: 'd6c9f5', fontStyle: 'italic' },
      // Builtins (`__dirname`, predefined constants): soft lavender,
      // distinct from plain identifiers where Monaco reports them.
      { token: 'variable.predefined', foreground: 'c4b5fd' },
      // Decorators/annotations: soft lavender, never lime.
      { token: 'decorator', foreground: 'c4b5fd' },
      { token: 'annotation', foreground: 'c4b5fd' },
      // Operators: light neutral, distinct from muted delimiters.
      { token: 'operator', foreground: 'cbd5e1' },
      // Delimiters/brackets: dimmed structural gray.
      { token: 'delimiter', foreground: '93a196' },
      { token: 'delimiter.bracket', foreground: '93a196' },
      { token: 'delimiter.parenthesis', foreground: '93a196' },
      { token: 'delimiter.angle', foreground: '93a196' },
      { token: 'delimiter.html', foreground: '93a196' },
      { token: 'delimiter.xml', foreground: '93a196' },
      // Regex: soft orange, distinct from strings/numbers.
      { token: 'regexp', foreground: 'e8a07a' },
      { token: 'regexp.escape', foreground: 'e8a07a' },
      { token: 'regexp.escape.control', foreground: 'e8a07a' },
      { token: 'regexp.invalid', foreground: 'f87171' },
      // Tags: soft red-pink family, distinct from keyword pink.
      { token: 'tag', foreground: 'fb7185' },
      { token: 'metatag', foreground: 'fb7185' },
      { token: 'metatag.html', foreground: 'fb7185' },
      { token: 'metatag.xml', foreground: 'fb7185' },
      { token: 'metatag.content.html', foreground: '7cc7ff' },
      { token: 'meta.tag', foreground: '9db8c7' },
      { token: 'meta.separator', foreground: '93a196' },
      { token: 'meta.scss', foreground: '9db8c7' },
      // Attributes: cyan names, green values, amber numbers/units —
      // selectors/properties/values stay visibly distinct in CSS.
      { token: 'attribute.name', foreground: '7cc7ff' },
      { token: 'attribute.name.html', foreground: '7cc7ff' },
      { token: 'attribute.value', foreground: '9ce8a0' },
      { token: 'attribute.value.html', foreground: '9ce8a0' },
      { token: 'attribute.value.xml', foreground: '9ce8a0' },
      { token: 'attribute.value.number', foreground: 'fbbf24' },
      { token: 'attribute.value.number.css', foreground: 'fbbf24' },
      { token: 'attribute.value.unit', foreground: 'fbbf24' },
      { token: 'attribute.value.unit.css', foreground: 'fbbf24' },
      { token: 'attribute.value.hex', foreground: 'e9f1ea' },
      { token: 'attribute.value.hex.css', foreground: 'e9f1ea' },
      // Markdown emphasis: body hue, style carries the meaning.
      { token: 'emphasis', foreground: 'e9f1ea', fontStyle: 'italic' },
      { token: 'strong', foreground: 'e9f1ea', fontStyle: 'bold' },
      // Invalid: diagnostic red, never hidden by syntax colors.
      { token: 'invalid', foreground: 'f87171' }
    ],
    // Seeds Monaco's semantic color map with the same restrained
    // palette so encoded semantic tokens resolve to STARK hues.
    encodedTokensColors: [
      '#FF7AB8',
      '#9CE8A0',
      '#FBBF24',
      '#7CC7FF',
      '#E3C878',
      '#9DB8C7',
      '#C4B5FD',
      '#F87171'
    ],
    colors: {
      'editor.background': '#0A0C0A',
      'editor.foreground': '#E9F1EA',
      'editor.lineHighlightBackground': '#171D19',
      'editorLineNumber.foreground': '#5F6F62',
      'editorLineNumber.activeForeground': '#93A196',
      'editorCursor.foreground': '#C8FF00',
      'editor.selectionBackground': '#C8FF0040',
      'editor.inactiveSelectionBackground': '#C8FF0020',
      'editorWidget.background': '#101412',
      'editorWidget.border': '#232B25',
      'editorHoverWidget.background': '#101412',
      'editorHoverWidget.border': '#232B25',
      'diffEditor.insertedTextBackground': '#3DDC8422',
      'diffEditor.removedTextBackground': '#F8717122',
      'editor.findMatchBackground': '#C8FF0044',
      'editor.findMatchHighlightBackground': '#C8FF0022',
      'editorGutter.background': '#0A0C0A',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#232B25',
      'editorIndentGuide.activeBackground1': '#3A4A3E',
      'editorWhitespace.foreground': '#232B25',
      // Restrained bracket-pair cycle (muted steel/sand/cyan —
      // never neon rainbow, never STARK lime).
      'editorBracketHighlight.foreground1': '#8EA8C3',
      'editorBracketHighlight.foreground2': '#E3C878',
      'editorBracketHighlight.foreground3': '#7CC7FF',
      'editorBracketHighlight.foreground4': '#9DB8C7',
      'editorBracketHighlight.foreground5': '#C4B5FD',
      'editorBracketHighlight.foreground6': '#93A196',
      'editorBracketHighlight.unexpectedBracket.foreground': '#F87171',
      // Matching bracket: subtle translucent lime wash, no heavy outline.
      'editorBracketMatch.background': '#C8FF0022',
      'editorBracketMatch.border': '#C8FF0055',
      // Bracket-pair guides track the same muted cycle.
      'editorBracketPairGuide.background1': '#8EA8C340',
      'editorBracketPairGuide.background2': '#E3C87840',
      'editorBracketPairGuide.background3': '#7CC7FF40',
      'editorBracketPairGuide.background4': '#9DB8C740',
      'editorBracketPairGuide.background5': '#C4B5FD40',
      'editorBracketPairGuide.background6': '#93A19640',
      'editorBracketPairGuide.activeBackground1': '#8EA8C366',
      'editorBracketPairGuide.activeBackground2': '#E3C87866',
      'editorBracketPairGuide.activeBackground3': '#7CC7FF66',
      'editorBracketPairGuide.activeBackground4': '#9DB8C766',
      'editorBracketPairGuide.activeBackground5': '#C4B5FD66',
      'editorBracketPairGuide.activeBackground6': '#93A19666',
      // Diagnostics stay visible above syntax colors.
      'editorError.foreground': '#F87171',
      'editorWarning.foreground': '#FBBF24',
      'editorInfo.foreground': '#7CC7FF',
      'editorHint.foreground': '#93A196'
    }
  }
}

/**
 * Official style primaries (mirrors style-registry.ts — no new hues).
 * The Monaco canvas cannot consume CSS vars, so caret/selection
 * colors resolve through this mapping: Magma reads volcano orange,
 * never lime. Semantic colors (success/warning/error/diagnostics)
 * are identical across styles.
 */
const STYLE_PRIMARY_HEX: Record<string, string> = {
  free: '#C8FF00',
  magma: '#FF6A00',
  frost: '#CFE9FF',
  void: '#F4F4F5'
}

/** Official primary hex for a brand style id (fail-closed to Free lime). */
export function brandPrimaryForStyleId(styleId: string): string {
  return STYLE_PRIMARY_HEX[styleId] ?? '#C8FF00'
}

/**
 * STARK theme tinted to one official primary: the eight lime-derived
 * caret/selection/match colors resolve from the given 6-digit hex
 * (validated; anything else falls back to Free lime). All other
 * token, diagnostic, and bracket colors are unchanged.
 */
export function starkEditorThemeForPrimary(primary: string): StarkEditorTheme {
  const base = starkEditorTheme()
  const match = /^#([0-9a-fA-F]{6})$/.exec(primary.trim())
  const hex = (match?.[1] ?? 'C8FF00').toUpperCase()
  return {
    ...base,
    colors: {
      ...base.colors,
      'editorCursor.foreground': `#${hex}`,
      'editor.selectionBackground': `#${hex}40`,
      'editor.inactiveSelectionBackground': `#${hex}20`,
      'editor.findMatchBackground': `#${hex}44`,
      'editor.findMatchHighlightBackground': `#${hex}22`,
      'editorBracketMatch.background': `#${hex}22`,
      'editorBracketMatch.border': `#${hex}55`
    }
  }
}

/** Current brand style id from the document dataset (Node-safe). */
export function documentStyleId(): string {
  try {
    const holder = globalThis as unknown as {
      readonly document?: { readonly documentElement?: { readonly dataset?: Record<string, string> } }
    }
    return holder.document?.documentElement?.dataset?.['starkStyle'] ?? 'free'
  } catch {
    return 'free'
  }
}

/**
 * Re-defines and activates the STARK theme tinted to the current
 * document style. Idempotent; call on mount and on style switches
 * for a live Magma caret with no editor remount.
 */
export function refreshStarkThemeForDocumentStyle(api: MonacoThemeApi): void {
  const theme = starkEditorThemeForPrimary(brandPrimaryForStyleId(documentStyleId()))
  api.editor.defineTheme(STARK_EDITOR_THEME_NAME, theme)
  api.editor.setTheme(STARK_EDITOR_THEME_NAME)
}

/**
 * Shared Monaco construction options for every STARK editor surface
 * (main editor, transaction diff, Git patch viewer). Uses only option
 * names that exist in Monaco 0.57: bracket-pair colorization, bracket
 * guides, semantic highlighting, and always-on bracket matching.
 * Lexical Monarch coloring works with zero extensions; semantic
 * providers (LSP/extensions) only improve it when present.
 */
export interface StarkMonacoConstructionOptions {
  readonly bracketPairColorization: { readonly enabled: boolean }
  readonly guides: {
    readonly bracketPairs: boolean | 'active'
    readonly bracketPairsHorizontal: boolean | 'active'
    readonly highlightActiveBracketPair: boolean
    readonly highlightActiveIndentation: boolean
    readonly indentation: boolean
  }
  readonly matchBrackets: 'always' | 'near' | 'never'
  readonly 'semanticHighlighting.enabled': boolean | 'configuredByTheme'
}

export function starkEditorConstructionOptions(): StarkMonacoConstructionOptions {
  return {
    bracketPairColorization: { enabled: true },
    guides: {
      bracketPairs: true,
      bracketPairsHorizontal: 'active',
      highlightActiveBracketPair: true,
      highlightActiveIndentation: true,
      indentation: true
    },
    matchBrackets: 'always',
    'semanticHighlighting.enabled': true
  }
}

/** Defines the STARK theme once and activates it. Idempotent. */
export function registerStarkTheme(api: MonacoThemeApi): void {
  api.editor.defineTheme(STARK_EDITOR_THEME_NAME, starkEditorTheme())
  api.editor.setTheme(STARK_EDITOR_THEME_NAME)
}

/** Extension-contributed editor theme data (bounded, renderer-safe). */
export interface ExtensionThemeData {
  readonly uiTheme: string
  readonly colors: Record<string, string>
  readonly tokenColors: readonly {
    readonly scope?: string | readonly string[]
    readonly settings: { readonly foreground?: string; readonly fontStyle?: string }
  }[]
}

const VALID_FONT_STYLE = /^(italic|bold|underline)(\s+(italic|bold|underline))*$/

function cleanHex(value: string): string | null {
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) {
    return hex.toLowerCase()
  }
  return null
}

/**
 * Converts a VS Code color-theme contribution into Monaco theme data
 * (pure, bounded, best-effort). Only editor colors apply — STARK's
 * application shell and security indicators are never touched. Token
 * scopes map to their last dotted segment (Monaco's flat token
 * model). Returns null when nothing usable survives.
 */
export function convertExtensionTheme(data: ExtensionThemeData): StarkEditorTheme | null {
  const rules: StarkTokenRule[] = []
  const seen = new Set<string>()
  for (const entry of data.tokenColors.slice(0, 256)) {
    const foreground = entry.settings.foreground !== undefined ? cleanHex(entry.settings.foreground) : null
    const fontStyle = entry.settings.fontStyle !== undefined && VALID_FONT_STYLE.test(entry.settings.fontStyle)
      ? entry.settings.fontStyle
      : undefined
    if (foreground === null && fontStyle === undefined) {
      continue
    }
    const scopes: string[] = typeof entry.scope === 'string' ? entry.scope.split(',') : Array.isArray(entry.scope) ? [...entry.scope] : []
    for (const scope of scopes.slice(0, 8)) {
      const token = scope.trim().split(/[\s.]/).filter((part) => part !== '').pop() ?? ''
      if (token === '' || token.length > 64 || seen.has(token)) {
        continue
      }
      seen.add(token)
      rules.push({ token, foreground: foreground ?? 'ffffff', fontStyle })
      if (rules.length >= 256) {
        break
      }
    }
    if (rules.length >= 256) {
      break
    }
  }
  const colors: Record<string, string> = {}
  for (const [key, value] of Object.entries(data.colors).slice(0, 256)) {
    if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(key)) {
      continue
    }
    const hex = cleanHex(value)
    if (hex !== null) {
      colors[key] = `#${hex}`
    }
  }
  if (rules.length === 0 && Object.keys(colors).length === 0) {
    return null
  }
  return {
    base: data.uiTheme === 'vs' ? 'vs' : 'vs-dark',
    inherit: true,
    rules,
    colors
  }
}

/**
 * Defines and activates one contributed editor theme under a stable
 * `stark-ext-theme` name. Returns false when the data converts to
 * nothing (caller keeps the STARK default).
 */
export function applyExtensionTheme(api: MonacoThemeApi, data: ExtensionThemeData): boolean {
  const converted = convertExtensionTheme(data)
  if (converted === null) {
    return false
  }
  api.editor.defineTheme('stark-ext-theme', converted)
  api.editor.setTheme('stark-ext-theme')
  return true
}
