import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  STARK_EDITOR_THEME_NAME,
  STARK_SEMANTIC_TOKEN_TYPES,
  applyExtensionTheme,
  convertExtensionTheme,
  registerStarkTheme,
  starkEditorConstructionOptions,
  starkEditorTheme
} from './editor-theme'
import { detectEditorLanguage } from './editor-language'

/**
 * PROJECT STARK mini feature: built-in VS Code-like code coloring.
 *
 * Regression net for stark-obsidian as the DEFAULT editor experience:
 * real Monaco tokenization, rich lexical + semantic rules, bracket-pair
 * colorization, extension-theme override compatibility — with no
 * Prettier/LSP/schema/IPC dependencies.
 */

function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').slice(0, 6)
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16)
  ]
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('stark obsidian is the default editor theme', () => {
  it('ships as stark-obsidian on vs-dark, inheriting', () => {
    assert.equal(STARK_EDITOR_THEME_NAME, 'stark-obsidian')
    const theme = starkEditorTheme()
    assert.equal(theme.base, 'vs-dark')
    assert.equal(theme.inherit, true)
  })

  it('every editor surface registers and activates it', () => {
    for (const relative of [
      'features/editor/CodeEditor.tsx',
      'features/editor/TransactionDiffEditor.tsx',
      'features/git/GitDiffViewer.tsx'
    ]) {
      const source = readRenderer(relative)
      assert.ok(source.includes('registerStarkTheme'), `${relative} must register the built-in theme`)
      assert.ok(source.includes('STARK_EDITOR_THEME_NAME'), `${relative} must activate stark-obsidian`)
    }
  })

  it('the theme picker offers STARK Obsidian as the default option', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('STARK Obsidian (default)'), 'picker must name STARK Obsidian as default')
    assert.ok(panel.includes("setSelectedExtensionTheme('editor', null)"), 'returning to default must clear the extension theme')
  })

  it('no extension is required for the default (offline, first launch)', () => {
    const bridge = readRenderer('features/extensions/extension-language-bridge.ts')
    assert.ok(
      bridge.includes('if (selected.editor === null)'),
      'null selection must restore the built-in theme'
    )
    const setup = readRenderer('features/editor/editor-setup.ts')
    assert.ok(!setup.includes('http://') && !setup.includes('https://'), 'monaco must load locally, never from a CDN')
  })
})

describe('language coverage over real Monaco grammars', () => {
  it('maps every required extension to a bundled language', () => {
    const cases: Readonly<Record<string, string>> = {
      'next.config.ts': 'typescript',
      'app.tsx': 'typescript',
      'web.js': 'javascript',
      'view.jsx': 'javascript',
      'tsconfig.json': 'json',
      'package.json': 'json',
      'README.md': 'markdown',
      'styles.css': 'css',
      'theme.scss': 'scss',
      'index.html': 'html',
      'config.yaml': 'yaml',
      'config.yml': 'yaml',
      'data.xml': 'xml',
      'main.py': 'python',
      'Main.java': 'java',
      'main.c': 'cpp',
      'core.cpp': 'cpp',
      'App.cs': 'csharp',
      'main.go': 'go',
      'lib.rs': 'rust',
      'run.sh': 'shell',
      'setup.ps1': 'powershell',
      'query.sql': 'sql'
    }
    for (const [path, language] of Object.entries(cases)) {
      assert.equal(detectEditorLanguage(path), language, path)
    }
  })

  it('falls back to plaintext for unknown files', () => {
    assert.equal(detectEditorLanguage('notes.unknownext'), 'plaintext')
    assert.equal(detectEditorLanguage('LICENSE'), 'plaintext')
  })

  it('uses Monaco built-in tokenization, never custom regex parsers', () => {
    const setup = readRenderer('features/editor/editor-setup.ts')
    assert.ok(
      setup.includes('monaco-editor/basic-languages/monaco.contribution'),
      'bundled Monarch grammars must register'
    )
    assert.ok(
      setup.includes('monaco-editor/language/json/monaco.contribution'),
      'JSON must register through its feature contribution'
    )
    for (const relative of [
      'features/editor/editor-setup.ts',
      'features/editor/editor-theme.ts',
      'features/editor/CodeEditor.tsx'
    ]) {
      const source = readRenderer(relative)
      assert.ok(!source.includes('registerMonarchTokensProvider'), `${relative} must not hand-roll tokenizers`)
    }
    const theme = readRenderer('features/editor/editor-theme.ts')
    assert.ok(!theme.includes('new RegExp'), 'the theme must not implement regex parsing')
  })

  it('each model takes its own detected language (TS/JS/JSON/MD/HTML/CSS)', () => {
    const editor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(editor.includes('monaco.editor.createModel('), 'each mount must own its model')
    const at = editor.indexOf('monaco.editor.createModel(')
    assert.ok(editor.slice(at, at + 400).includes('mountProps.language'), 'model must take the detected language id')
    assert.equal(detectEditorLanguage('a.ts'), 'typescript')
    assert.equal(detectEditorLanguage('a.js'), 'javascript')
    assert.equal(detectEditorLanguage('a.json'), 'json')
    assert.equal(detectEditorLanguage('a.md'), 'markdown')
    assert.equal(detectEditorLanguage('a.html'), 'html')
    assert.equal(detectEditorLanguage('a.css'), 'css')
  })
})

describe('rich lexical token rules (never mostly white)', () => {
  it('gives keyword/string/type/function/property/comment/number distinct hues', () => {
    const theme = starkEditorTheme()
    const byToken = new Map(theme.rules.map((rule) => [rule.token, rule.foreground.toLowerCase()]))
    for (const token of ['keyword', 'string', 'type', 'function', 'property', 'comment', 'number']) {
      const foreground = byToken.get(token)
      assert.ok(typeof foreground === 'string' && /^[0-9a-f]{6}$/.test(foreground), `${token} must have a token rule`)
    }
    const varied = ['comment', 'keyword', 'string', 'number', 'type', 'function', 'property'].map(
      (token) => byToken.get(token)
    )
    assert.deepEqual([...new Set(varied)].length, varied.length, 'syntax categories must not share a foreground')
    assert.ok(!varied.includes('e9f1ea'), 'no syntax category may reuse the default text foreground')
  })

  it('covers operators, regex, tags, and attributes', () => {
    const byToken = new Map(starkEditorTheme().rules.map((rule) => [rule.token, rule.foreground.toLowerCase()]))
    for (const token of [
      'operator',
      'regexp',
      'tag',
      'attribute.name',
      'attribute.value',
      'attribute.value.number',
      'attribute.value.unit'
    ]) {
      assert.ok(byToken.has(token), `${token} must have a token rule`)
      assert.ok(byToken.get(token) !== 'e9f1ea', `${token} must differ from default text`)
    }
    assert.ok(byToken.get('operator') !== byToken.get('delimiter'), 'operators must differ from delimiters')
  })

  it('distinguishes JSON keys, strings, keywords, and numbers', () => {
    const byToken = new Map(starkEditorTheme().rules.map((rule) => [rule.token, rule.foreground.toLowerCase()]))
    const key = byToken.get('string.key.json')
    const value = byToken.get('string.value.json')
    const keyword = byToken.get('keyword.json')
    const number = byToken.get('number')
    assert.ok(key !== undefined && value !== undefined && keyword !== undefined && number !== undefined)
    assert.ok(key !== value, 'JSON keys must differ from string values')
    assert.ok(keyword !== value, 'JSON booleans/null must differ from strings')
    assert.ok(number !== value && number !== key, 'JSON numbers must stand apart')
  })

  it('distinguishes markdown headings, links, code, emphasis, and quotes', () => {
    const byToken = new Map(
      starkEditorTheme().rules.map((rule) => [rule.token, `${rule.foreground.toLowerCase()}|${rule.fontStyle ?? ''}`])
    )
    for (const token of ['keyword', 'string', 'string.link', 'emphasis', 'strong', 'comment']) {
      assert.ok(byToken.has(token), `markdown-relevant ${token} rule must exist`)
    }
    assert.ok((byToken.get('emphasis') ?? '').includes('italic'), 'emphasis must italicize')
    assert.ok((byToken.get('strong') ?? '').includes('bold'), 'strong must bolden')
    assert.ok((byToken.get('string.link') ?? '').includes('underline'), 'links must underline')
  })

  it('distinguishes HTML tags/attributes/strings and CSS selectors/values/units', () => {
    const byToken = new Map(starkEditorTheme().rules.map((rule) => [rule.token, rule.foreground.toLowerCase()]))
    assert.ok(byToken.get('tag') !== byToken.get('attribute.name'), 'tags must differ from attributes')
    assert.ok(byToken.get('attribute.name') !== byToken.get('attribute.value'), 'attribute names must differ from values')
    assert.ok(
      byToken.get('attribute.value.number') === byToken.get('number'),
      'CSS numeric values must read as numbers'
    )
  })

  it('never renders code as mostly white text', () => {
    const theme = starkEditorTheme()
    const white = theme.rules.filter((rule) => rule.foreground.toLowerCase() === 'e9f1ea')
    assert.ok(white.length / theme.rules.length < 0.4, 'default-white rules must stay a minority')
    const hues = new Set(theme.rules.map((rule) => rule.foreground.toLowerCase()))
    assert.ok(hues.size >= 8, 'theme must carry a varied palette')
    assert.ok(!hues.has('c8ff00'), 'no token rule may wear UI lime')
  })
})

describe('semantic token colors (progressive enhancement)', () => {
  it('declares every required semantic token type', () => {
    for (const token of [
      'class',
      'interface',
      'type',
      'enum',
      'function',
      'method',
      'property',
      'parameter',
      'variable',
      'namespace',
      'decorator'
    ]) {
      assert.ok(STARK_SEMANTIC_TOKEN_TYPES.includes(token), `semantic list must include ${token}`)
    }
  })

  it('carries theme rules for each semantic type', () => {
    const tokens = new Set(starkEditorTheme().rules.map((rule) => rule.token))
    for (const token of STARK_SEMANTIC_TOKEN_TYPES) {
      assert.ok(tokens.has(token), `theme must rule ${token}`)
    }
  })

  it('seeds encodedTokensColors for Monaco semantic rendering', () => {
    const theme = starkEditorTheme()
    assert.ok(Array.isArray(theme.encodedTokensColors) && (theme.encodedTokensColors?.length ?? 0) >= 4)
    for (const color of theme.encodedTokensColors ?? []) {
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(color), `${color} must be #RRGGBB`)
    }
  })

  it('enables semantic highlighting without requiring it', () => {
    assert.equal(starkEditorConstructionOptions()['semanticHighlighting.enabled'], true)
    const setup = readRenderer('features/editor/editor-setup.ts')
    assert.ok(!setup.includes('registerDocumentSemanticTokensProvider'), 'lexical coloring must not wait on semantic providers')
    const editor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(editor.includes('Extension features are best-effort'), 'missing providers must degrade gracefully')
  })
})

describe('bracket pair coloring and guides', () => {
  it('enables bracket colorization and guides through supported option names', () => {
    const options = starkEditorConstructionOptions()
    assert.equal(options.bracketPairColorization.enabled, true)
    assert.equal(options.guides.bracketPairs, true)
    assert.equal(options.guides.highlightActiveBracketPair, true)
    assert.equal(options.matchBrackets, 'always')
  })

  it('applies the shared options on every editor surface', () => {
    for (const relative of [
      'features/editor/CodeEditor.tsx',
      'features/editor/TransactionDiffEditor.tsx',
      'features/git/GitDiffViewer.tsx'
    ]) {
      assert.ok(
        readRenderer(relative).includes('starkEditorConstructionOptions()'),
        `${relative} must spread the shared coloring options`
      )
    }
  })

  it('cycles bracket pairs through a restrained (non-neon) set', () => {
    const colors = starkEditorTheme().colors
    const cycle = [1, 2, 3, 4, 5, 6].map((n) => colors[`editorBracketHighlight.foreground${n}`])
    assert.ok(cycle.every((color) => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color ?? '')))
    assert.deepEqual([...new Set(cycle)].length, cycle.length, 'bracket levels must cycle distinctly')
    for (const color of cycle) {
      assert.ok(!['#C8FF00', '#FF0000', '#00FF00', '#0000FF'].includes((color ?? '').toUpperCase()))
    }
    assert.equal(colors['editorBracketHighlight.unexpectedBracket.foreground'], '#F87171')
  })

  it('keeps the active bracket match subtle (no giant lime outline)', () => {
    const colors = starkEditorTheme().colors
    assert.ok(typeof colors['editorBracketMatch.background'] === 'string')
    assert.ok(typeof colors['editorBracketMatch.border'] === 'string')
    assert.ok(colors['editorBracketMatch.border'] !== '#C8FF00', 'match border must stay translucent, never solid lime')
  })

  it('enables bracket-pair guides on the same muted cycle', () => {
    const colors = starkEditorTheme().colors
    for (const n of [1, 2, 3]) {
      assert.ok(typeof colors[`editorBracketPairGuide.background${n}`] === 'string')
      assert.ok(typeof colors[`editorBracketPairGuide.activeBackground${n}`] === 'string')
    }
  })
})

describe('caret, selection, comments, diagnostics', () => {
  it('keeps STARK lime on the caret and translucent selections', () => {
    const colors = starkEditorTheme().colors
    assert.equal(colors['editorCursor.foreground'], '#C8FF00')
    assert.ok((colors['editor.selectionBackground'] ?? '').startsWith('#C8FF00'))
    assert.ok((colors['editor.inactiveSelectionBackground'] ?? '').startsWith('#C8FF00'))
    assert.equal(colors['editor.lineHighlightBackground'], '#171D19')
  })

  it('mutes comments (darker than body text, italic)', () => {
    const theme = starkEditorTheme()
    const comment = theme.rules.find((rule) => rule.token === 'comment')
    assert.ok(comment?.fontStyle?.includes('italic'), 'comments must italicize')
    assert.ok((comment?.foreground.toLowerCase() ?? '') !== 'e9f1ea', 'comments must differ from body text')
    assert.ok(
      luminance(comment?.foreground ?? '000000') < luminance('E9F1EA'),
      'comments must read darker (muted) than body text'
    )
  })

  it('preserves diagnostic styling above syntax colors', () => {
    const colors = starkEditorTheme().colors
    assert.equal(colors['editorError.foreground'], '#F87171')
    assert.equal(colors['editorWarning.foreground'], '#FBBF24')
    assert.equal(colors['editorInfo.foreground'], '#7CC7FF')
    assert.equal(colors['editorHint.foreground'], '#93A196')
    const editor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(editor.includes('applyExtensionMarkers'), 'extension diagnostics must still apply as model markers')
  })
})

describe('extension theme compatibility', () => {
  it('lets installed themes override editor colors only', () => {
    const converted = convertExtensionTheme({
      uiTheme: 'vs-dark',
      colors: { 'editor.background': '#1E1E1E' },
      tokenColors: [{ scope: 'comment', settings: { foreground: '#6A9955' } }]
    })
    assert.ok(converted !== null)
    const calls: string[] = []
    assert.equal(
      applyExtensionTheme(
        {
          editor: {
            defineTheme: (name) => {
              calls.push(`define:${name}`)
            },
            setTheme: (name) => {
              calls.push(`set:${name}`)
            }
          }
        },
        {
          uiTheme: 'vs-dark',
          colors: { 'editor.background': '#1E1E1E' },
          tokenColors: [{ scope: 'comment', settings: { foreground: '#6A9955' } }]
        }
      ),
      true
    )
    assert.deepEqual(calls, ['define:stark-ext-theme', 'set:stark-ext-theme'])
  })

  it('restores stark-obsidian immediately when returning to default', () => {
    const bridge = readRenderer('features/extensions/extension-language-bridge.ts')
    assert.ok(bridge.includes('registerStarkTheme(monaco)'), 'fallback must restore the built-in theme')
    const calls: string[] = []
    registerStarkTheme({
      editor: {
        defineTheme: (name) => {
          calls.push(`define:${name}`)
        },
        setTheme: (name) => {
          calls.push(`set:${name}`)
        }
      }
    })
    assert.deepEqual(calls, [`define:${STARK_EDITOR_THEME_NAME}`, `set:${STARK_EDITOR_THEME_NAME}`])
  })

  it('never applies extension themes to the app shell', () => {
    const theme = readRenderer('features/editor/editor-theme.ts')
    assert.ok(!theme.includes('AppChrome') && !theme.includes('drawer'), 'theme seam must stay editor-only')
    const bridge = readRenderer('features/extensions/extension-language-bridge.ts')
    assert.ok(bridge.includes('editor themes') || bridge.includes('editor theme'), 'bridge must scope themes to the editor')
  })
})

describe('no formatter, lsp, schema, or ipc coupling', () => {
  it('coloring never touches Prettier or the formatter registry', () => {
    for (const relative of [
      'features/editor/editor-theme.ts',
      'features/editor/editor-setup.ts',
      'features/editor/CodeEditor.tsx',
      'features/extensions/extension-language-bridge.ts'
    ]) {
      const source = readRenderer(relative).toLowerCase()
      assert.ok(!source.includes('prettier'), `${relative} must not reference Prettier`)
    }
    const theme = readRenderer('features/editor/editor-theme.ts')
    assert.ok(!theme.includes('format-request-bus') && !theme.includes('formatter'), 'theme must not import formatting')
  })

  it('coloring never requires eslint, language servers, or extensions', () => {
    for (const relative of [
      'features/editor/editor-theme.ts',
      'features/editor/editor-setup.ts',
      'features/editor/CodeEditor.tsx'
    ]) {
      const lowered = readRenderer(relative).toLowerCase()
      assert.ok(!lowered.includes('eslint'), `${relative} must not require ESLint`)
      assert.ok(!lowered.includes('languageserver') && !lowered.includes('language-server'), `${relative} must not require an LSP`)
    }
    assert.equal(detectEditorLanguage('next.config.ts'), 'typescript', 'TS colors must resolve with zero extensions')
  })

  it('leaves schema v19 and IPC untouched', () => {
    const migrations = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(migrations).map((name) => name.toLowerCase())
    assert.ok(files.includes('019-message-attachments.ts'), 'schema v19 must remain')
    assert.ok(!files.some((name) => name.startsWith('020-')), 'no schema migration may be added')
    for (const relative of [
      'features/editor/editor-theme.ts',
      'features/editor/editor-setup.ts',
      'features/editor/editor-language.ts'
    ]) {
      const source = readRenderer(relative)
      assert.ok(!source.includes('ipcRenderer') && !source.includes('stark-api'), `${relative} must not touch IPC`)
    }
  })
})
