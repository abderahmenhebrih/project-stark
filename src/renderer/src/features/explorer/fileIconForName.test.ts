import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getFileIconKind } from './fileIconForName'

describe('file icon mapping', () => {
  it('maps markdown files to the markdown icon', () => {
    for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/Guide.MARKDOWN']) {
      assert.equal(getFileIconKind(name), 'markdown')
    }
  })

  it('maps JavaScript variants to the JavaScript icon', () => {
    for (const name of ['app.js', 'lib.mjs', 'legacy.cjs', 'view.jsx', 'eslint.config.mjs', 'APP.JS']) {
      assert.equal(getFileIconKind(name), 'javascript')
    }
  })

  it('maps TypeScript variants including declaration files to the TypeScript icon', () => {
    for (const name of ['main.ts', 'types.d.ts', 'next-env.d.ts', 'next.config.ts', 'mod.mts', 'lib.cts', 'app.tsx']) {
      assert.equal(getFileIconKind(name), 'typescript')
    }
  })

  it('maps JSON variants to the JSON icon', () => {
    assert.equal(getFileIconKind('data.json'), 'json')
    assert.equal(getFileIconKind('tsconfig.jsonc'), 'json')
  })

  it('maps manifests to the package and TypeScript icons', () => {
    assert.equal(getFileIconKind('package.json'), 'package')
    assert.equal(getFileIconKind('package-lock.json'), 'package')
    assert.equal(getFileIconKind('tsconfig.json'), 'typescript')
    assert.equal(getFileIconKind('tsconfig.tsbuildinfo'), 'config')
  })

  it('maps git metadata files to the Git icon', () => {
    assert.equal(getFileIconKind('.gitignore'), 'git')
    assert.equal(getFileIconKind('.gitattributes'), 'git')
  })

  it('maps dotfiles and config formats to the config icon', () => {
    for (const name of ['.env', '.npmrc', 'config.yaml', 'settings.toml', 'app.ini']) {
      assert.equal(getFileIconKind(name), 'config')
    }
    assert.equal(getFileIconKind('postcss.config.mjs'), 'javascript')
  })

  it('falls back to the generic document icon', () => {
    for (const name of ['notes.txt', 'image.png', 'LICENSE', 'run.sh', 'styles.css', 'unknown.xyz']) {
      assert.equal(getFileIconKind(name), 'document')
    }
  })
})
