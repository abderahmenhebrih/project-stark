import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { detectEditorLanguage, detectEditorLanguageWithOverrides, KNOWN_MONACO_LANGUAGE_IDS } from './editor-language'

describe('editor language mapping', () => {
  it('maps representative development extensions', () => {
    const cases: Readonly<Record<string, string>> = {
      'src/main.ts': 'typescript',
      'app.tsx': 'typescript',
      'web.js': 'javascript',
      'view.jsx': 'javascript',
      'pkg.mjs': 'javascript',
      'pkg.cjs': 'javascript',
      'tsconfig.json': 'json',
      'styles.css': 'css',
      'theme.scss': 'scss',
      'index.html': 'html',
      'old.htm': 'html',
      'README.md': 'markdown',
      'main.py': 'python',
      'Main.java': 'java',
      'main.c': 'cpp',
      'util.h': 'cpp',
      'core.cpp': 'cpp',
      'core.cc': 'cpp',
      'api.hpp': 'cpp',
      'App.cs': 'csharp',
      'main.go': 'go',
      'lib.rs': 'rust',
      'index.php': 'php',
      'query.sql': 'sql',
      'run.sh': 'shell',
      'setup.ps1': 'powershell',
      'config.yaml': 'yaml',
      'config.yml': 'yaml',
      'data.xml': 'xml'
    }
    for (const [path, language] of Object.entries(cases)) {
      assert.equal(detectEditorLanguage(path), language, path)
      assert.equal(detectEditorLanguage(`nested/dir/${path}`), language, `nested ${path}`)
    }
  })

  it('matches case-insensitively and deterministically', () => {
    assert.equal(detectEditorLanguage('README.MD'), 'markdown')
    assert.equal(detectEditorLanguage('SRC/MAIN.TS'), 'typescript')
    assert.equal(detectEditorLanguage('Setup.PS1'), 'powershell')
    assert.equal(detectEditorLanguage('a.ts'), detectEditorLanguage('a.ts'))
  })

  it('maps special basenames', () => {
    assert.equal(detectEditorLanguage('Dockerfile'), 'dockerfile')
    assert.equal(detectEditorLanguage('deploy/Dockerfile'), 'dockerfile')
  })

  it('falls back to plaintext without inspecting contents', () => {
    for (const path of ['LICENSE', '.gitignore', 'Makefile', 'notes.txt', 'archive.tar.gz', '.hidden', 'noext.', 'a.unknownext']) {
      assert.equal(detectEditorLanguage(path), 'plaintext', path)
    }
  })

  it('resolves next.config.ts to TypeScript, never plaintext', () => {
    assert.equal(detectEditorLanguage('next.config.ts'), 'typescript')
    assert.equal(detectEditorLanguageWithOverrides('next.config.ts', null), 'typescript')
    assert.equal(detectEditorLanguageWithOverrides('next.config.ts', {}), 'typescript')
  })

  it('maps TSX/JSX to the correct Monaco equivalents', () => {
    // Monaco 0.57 ships no typescriptreact/javascriptreact grammars;
    // the plain ids are the correct equivalents (never plaintext).
    assert.equal(detectEditorLanguage('app.tsx'), 'typescript')
    assert.equal(detectEditorLanguage('view.jsx'), 'javascript')
    assert.equal(detectEditorLanguage('next.config.ts'), 'typescript')
    assert.equal(detectEditorLanguage('a.js'), 'javascript')
    assert.equal(detectEditorLanguage('tsconfig.json'), 'json')
    assert.equal(detectEditorLanguage('README.md'), 'markdown')
    assert.equal(detectEditorLanguage('styles.css'), 'css')
    assert.equal(detectEditorLanguage('index.html'), 'html')
  })

  it('ignores overrides pointing at languages Monaco never bundled', () => {
    // A bogus contributed id must fall through to the built-in
    // mapping instead of building an untokenizable model.
    assert.equal(detectEditorLanguageWithOverrides('a.ts', { ts: 'made-up' }), 'typescript')
    assert.equal(detectEditorLanguageWithOverrides('a.ts', { ts: '' }), 'typescript')
    assert.equal(detectEditorLanguageWithOverrides('a.py', { py: 'not-a-language' }), 'python')
  })

  it('honors contributed overrides for real Monaco languages', () => {
    // Extension-contributed grammars Monaco actually bundles keep
    // working (Monaco 0.57 ships no vue grammar, so vue falls
    // through; handlebars/graphql ship and still win).
    assert.equal(detectEditorLanguageWithOverrides('a.vue', { vue: 'vue' }), 'plaintext')
    assert.equal(detectEditorLanguageWithOverrides('a.hbs', { hbs: 'handlebars' }), 'handlebars')
    assert.equal(detectEditorLanguageWithOverrides('a.gql', { gql: 'graphql' }), 'graphql')
    // The JSON language registers through its own feature
    // contribution, so json overrides stay valid too.
    assert.equal(detectEditorLanguageWithOverrides('a.json', { json: 'json' }), 'json')
    // Override ids normalize to Monaco's lowercase form.
    assert.equal(detectEditorLanguageWithOverrides('a.ts', { ts: 'TypeScript' }), 'typescript')
  })

  it('known Monaco ids stay in sync with the installed package', () => {
    const contribution = join(process.cwd(), 'node_modules', 'monaco-editor', 'esm', 'vs', 'basic-languages', 'monaco.contribution.js')
    assert.ok(existsSync(contribution), 'installed Monaco must expose its language contribution file')
    const source = readFileSync(contribution, 'utf8')
    const upstream = new Set(
      [...source.matchAll(/definitions\/([a-z0-9-]+)\/register/g)].map((match) => match[1] as string)
    )
    assert.ok(upstream.size > 80, 'upstream language set must be substantial')
    assert.ok(!upstream.has('json'), 'json must come from the language feature, not basic-languages')
    for (const id of ['typescript', 'javascript', 'json', 'markdown', 'css', 'html', 'python']) {
      assert.ok(KNOWN_MONACO_LANGUAGE_IDS.has(id), `${id} must be known`)
    }
    assert.ok(!KNOWN_MONACO_LANGUAGE_IDS.has('typescriptreact'), 'no invented react variants may be known')
    assert.ok(!KNOWN_MONACO_LANGUAGE_IDS.has('plaintext'), 'plaintext is a fallback, not a grammar')
    assert.ok(!KNOWN_MONACO_LANGUAGE_IDS.has('vue'), 'unbundled extension-only ids must stay unknown')
    assert.deepEqual(
      [...KNOWN_MONACO_LANGUAGE_IDS].sort(),
      [...upstream, 'json'].sort(),
      'known ids must exactly match the bundled Monaco grammars plus the JSON feature (update both on upgrade)'
    )
  })
})
