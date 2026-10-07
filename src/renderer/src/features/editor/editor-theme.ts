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
  readonly base: 'vs-dark'
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
