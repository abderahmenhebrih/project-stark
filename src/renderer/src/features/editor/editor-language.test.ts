import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectEditorLanguage } from './editor-language'

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
})
