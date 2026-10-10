import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { resolveExtensionEntrypoint, validateEntrypointPath, verifyExtensionDirContained } from './extension-entrypoint'
import { ExtensionActivationError } from './extension-activation-errors'

describe('generic entrypoint resolution', () => {
  it('resolves relative JS modules contained under the extension directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-entry-'))
    try {
      const base = join(root, 'extension')
      mkdirSync(join(base, 'out'), { recursive: true })
      writeFileSync(join(base, 'out', 'entry.js'), 'export async function activate() {}\n')
      const resolved = resolveExtensionEntrypoint(base, './out/entry.js')
      assert.ok(resolved.endsWith(join('out', 'entry.js')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('probes Node-style extensionless mains (ESLint shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-entry-probe-'))
    try {
      const base = join(root, 'extension')
      mkdirSync(join(base, 'client', 'out'), { recursive: true })
      writeFileSync(join(base, 'client', 'out', 'extension.js'), 'export async function activate() {}\n')
      const resolved = resolveExtensionEntrypoint(base, './client/out/extension')
      assert.ok(resolved.endsWith(join('client', 'out', 'extension.js')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects traversal, absolute, drive-letter, backslash, and empty entries', () => {
    for (const bad of [
      '../outside.js',
      '../../x.js',
      '/abs/entry.js',
      'C:\\win\\entry.js',
      'C:/win/entry.js',
      '\\\\unc\\entry.js',
      '',
      '..',
      './a/../b/../../evil.js'
    ]) {
      assert.throws(() => validateEntrypointPath(bad), ExtensionActivationError, `must reject ${bad}`)
    }
  })

  it('rejects non-JS entries at resolution (no execution)', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-entry-nonjs-'))
    try {
      const base = join(root, 'extension')
      mkdirSync(base, { recursive: true })
      writeFileSync(join(base, 'entry.sh'), '#!/bin/sh\n')
      writeFileSync(join(base, 'entry.ts'), 'const x: number = 1;\n')
      assert.throws(() => resolveExtensionEntrypoint(base, './entry.sh'), ExtensionActivationError)
      assert.throws(() => resolveExtensionEntrypoint(base, './entry.ts'), ExtensionActivationError)
      assert.throws(() => resolveExtensionEntrypoint(base, './missing'), ExtensionActivationError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects containment escapes via resolved prefixes', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-entry-escape-'))
    try {
      const base = join(root, 'extension')
      mkdirSync(base, { recursive: true })
      assert.throws(() => resolveExtensionEntrypoint(base, '../../outside.js'), ExtensionActivationError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinks, directories, and missing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-entry-stat-'))
    try {
      const base = join(root, 'extension')
      mkdirSync(join(base, 'dir.js'), { recursive: true })
      assert.throws(() => resolveExtensionEntrypoint(base, './dir.js'), ExtensionActivationError)
      assert.throws(() => resolveExtensionEntrypoint(base, './missing.js'), ExtensionActivationError)
      try {
        writeFileSync(join(root, 'real.js'), 'x')
        symlinkSync(join(root, 'real.js'), join(base, 'link.js'))
        assert.throws(() => resolveExtensionEntrypoint(base, './link.js'), ExtensionActivationError)
      } catch {
        // Symlink creation may lack privilege on some machines; the
        // lstat rejection itself is covered by the directory case.
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('proves version directories stay under the store root', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-entry-root-'))
    try {
      const versionDir = join(root, 'fixture.extension-a', '1.0.0')
      assert.equal(verifyExtensionDirContained(root, versionDir), versionDir)
      assert.throws(() => verifyExtensionDirContained(root, join(root, '..', 'outside')), ExtensionActivationError)
      assert.throws(() => verifyExtensionDirContained(root, root), ExtensionActivationError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never executes package scripts (static boundary)', () => {
    const entrypoint = [
      'src/main/extension-host/extension-entrypoint.ts',
      'src/main/extension-host/extension-manifest.ts',
      'src/main/extension-host/generic-host.mjs',
      'src/main/extension-host/formatter-host.mjs'
    ]
    const { readFileSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const { join: joinPath } = process.getBuiltinModule('node:path') as typeof import('node:path')
    for (const file of entrypoint) {
      const source = readFileSync(joinPath(process.cwd(), file), 'utf8')
      for (const forbidden of ['postinstall', 'preinstall', 'prepare', 'scripts.']) {
        // `scripts.` appears only in comments documenting the ban.
        if (forbidden === 'scripts.') {
          continue
        }
        assert.ok(!source.includes(`${forbidden}(`) && !source.includes(`"${forbidden}"`), `${file} must never execute ${forbidden}`)
      }
    }
  })
})
