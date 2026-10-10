import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Monaco highlighting wiring guarantees.
 *
 * Root cause of all-white code: `loadMonaco` imported only
 * `editor.api`, which registers zero Monarch grammars, so no model
 * could ever tokenize. The side-effect contribution import below is
 * what makes lexical highlighting (no LSP) possible. Runs against
 * repository source (cwd is the repo root via npm).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('monaco language registration', () => {
  it('loads bundled grammars alongside the editor API (no custom regex coloring)', () => {
    const setup = readRenderer('features/editor/editor-setup.ts')
    assert.ok(setup.includes("import('monaco-editor/editor/editor.api')"), 'editor API must load')
    assert.ok(
      setup.includes('monaco-editor/basic-languages/monaco.contribution'),
      'bundled Monarch grammars must register through the audited contribution entry'
    )
    assert.ok(
      setup.includes('monaco-editor/language/json/monaco.contribution'),
      'the JSON language must register through its feature contribution (no basic-languages JSON definition exists)'
    )
    assert.ok(!setup.includes('registerMonarchTokensProvider'), 'no hand-rolled tokenizers may replace bundled grammars')
  })

  it('ships the grammars in the built renderer bundle', () => {
    const assets = join(process.cwd(), 'out', 'renderer', 'assets')
    assert.ok(existsSync(assets), 'renderer bundle must exist (run npm run build first)')
    // Vite may split the contribution chain out of the editor chunk;
    // scan every emitted asset (bounded file count, marker search).
    const chunks = readdirSync(assets).filter((name: string) => name.endsWith('.js'))
    assert.ok(chunks.length > 0 && chunks.length < 100, 'asset set must be bounded')
    const sources = chunks.map((name: string) => readFileSync(join(assets, name), 'utf8'))
    assert.ok(
      sources.some((bundle: string) => bundle.includes('registerTokensProviderFactory')),
      'the bundle must carry Monarch language registrations (tokenizer factories), not just the editor shell'
    )
    assert.ok(
      sources.some((bundle: string) => bundle.includes('.bowerrc')),
      'the bundle must carry the JSON language contribution (registers the json grammar)'
    )
  })
})

describe('monaco model language contract', () => {
  it('creates each model with its own detected language (no plaintext inheritance)', () => {
    const editor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(editor.includes('monaco.editor.createModel('), 'each mount must own its model')
    const createAt = editor.indexOf('monaco.editor.createModel(')
    const createSlice = editor.slice(createAt, createAt + 400)
    assert.ok(createSlice.includes('mountProps.language'), 'the model must take the detected language id')
    assert.ok(editor.includes('model.dispose()'), 'unmount must dispose the model')
    assert.ok(editor.includes('instance?.editor.dispose()') || editor.includes('editor.dispose()'), 'unmount must dispose the editor')
  })

  it('remounts per file so languages never leak across file switches', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(
      explorer.includes('key={`edit:${workspaceId}:${state.preview.path}:${state.preview.revision}`}'),
      'the editable editor must remount per file+revision'
    )
    assert.ok(
      explorer.includes('detectEditorLanguageWithOverrides(state.preview.path, languageOverrides)'),
      'each file must resolve its own language id'
    )
  })

  it('extension theme overrides keep working through the narrow seam', () => {
    const bridge = readRenderer('features/extensions/extension-language-bridge.ts')
    assert.ok(bridge.includes('ensureExtensionTheme'), 'installed editor themes must still apply')
    const theme = readRenderer('features/editor/editor-theme.ts')
    assert.ok(theme.includes('applyExtensionTheme'), 'extension theme application must remain')
    assert.ok(theme.includes('stark-ext-theme'), 'extension themes must keep their own Monaco name')
    assert.ok(!theme.includes('stark-obsidian') || theme.includes('STARK_EDITOR_THEME_NAME'), 'shell branding must not leak into Monaco names')
  })
})
