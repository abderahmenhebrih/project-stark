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
  readonly colors: Record<string, string>
}

/** Theme data: near-black background, lime reserved for caret/accents. */
export function starkEditorTheme(): StarkEditorTheme {
  return {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5f6f62', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c8ff00' },
      { token: 'string', foreground: '9ce8a0' },
      { token: 'number', foreground: 'fbbf24' },
      { token: 'type', foreground: '7dd3a8' },
      { token: 'identifier', foreground: 'e9f1ea' },
      { token: 'delimiter', foreground: '93a196' }
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
      'editorWhitespace.foreground': '#232B25'
    }
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
