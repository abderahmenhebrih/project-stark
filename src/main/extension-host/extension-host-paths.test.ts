import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  SHIPPED_HOST_FILES,
  devExtensionHostSourceDir,
  ensureExtensionHostArtifacts,
  extensionHostArtifactsComplete,
  missingExtensionHostArtifacts
} from './extension-host-paths'

describe('extension host artifact paths (dev + packaged)', () => {
  it('ships the audited six-file set with no absolute paths', () => {
    assert.equal(SHIPPED_HOST_FILES.length, 6)
    const dests = SHIPPED_HOST_FILES.map((file) => file.dest)
    assert.ok(dests.includes('extension-host-bootstrap.js'))
    assert.ok(dests.includes('generic-host.mjs'))
    assert.ok(dests.includes('formatter-host.mjs'))
    assert.ok(dests.includes('vscode-shim.mjs'))
    assert.ok(dests.includes('vscode-loader.mjs'))
    assert.ok(dests.includes('extension-process.mjs'))
    for (const file of SHIPPED_HOST_FILES) {
      assert.ok(!file.src.includes(':') && !file.dest.includes(':'), 'no absolute paths in the manifest')
    }
  })

  it('matches the copy script file list exactly', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'copy-extension-host-bootstrap.cjs'), 'utf8')
    for (const file of SHIPPED_HOST_FILES) {
      assert.ok(script.includes(`'${file.src}'`), `copy script must ship ${file.src}`)
      assert.ok(script.includes(`'${file.dest}'`), `copy script must ship ${file.dest}`)
    }
  })

  it('detects completeness and restores missing artifacts verbatim from source', () => {
    const mainDir = join(tmpdir(), `stark-host-paths-main-${Date.now()}`)
    const sourceDir = join(tmpdir(), `stark-host-paths-src-${Date.now()}`)
    try {
      mkdirSync(sourceDir, { recursive: true })
      for (const file of SHIPPED_HOST_FILES) {
        writeFileSync(join(sourceDir, file.src), `// audited ${file.src}\n`)
      }
      assert.equal(extensionHostArtifactsComplete(mainDir), false)
      assert.equal(missingExtensionHostArtifacts(mainDir).length, 6)
      const copied = ensureExtensionHostArtifacts(mainDir, sourceDir)
      assert.equal(copied.length, 6)
      assert.equal(extensionHostArtifactsComplete(mainDir), true)
      assert.deepEqual(missingExtensionHostArtifacts(mainDir), [])
      for (const file of SHIPPED_HOST_FILES) {
        assert.equal(readFileSync(join(mainDir, file.dest), 'utf8'), `// audited ${file.src}\n`)
        assert.ok(existsSync(join(mainDir, file.dest)))
      }
      // Idempotent: a second ensure copies nothing.
      assert.deepEqual(ensureExtensionHostArtifacts(mainDir, sourceDir), [])
    } finally {
      rmSync(mainDir, { recursive: true, force: true })
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  it('derives the dev source dir from the app path (never hardcoded)', () => {
    assert.equal(
      devExtensionHostSourceDir('/some/app'),
      join('/some/app', 'src', 'main', 'extension-host')
    )
    const live = devExtensionHostSourceDir(process.cwd())
    assert.ok(existsSync(join(live, 'bootstrap.js')), 'dev source dir must hold the audited bootstrap')
    assert.ok(existsSync(join(live, 'generic-host.mjs')), 'dev source dir must hold the generic host')
  })

  it('the built output carries the fork entrypoint after build', () => {
    const shipped = join(process.cwd(), 'out', 'main', 'extension-host-bootstrap.js')
    assert.ok(existsSync(shipped), 'production build must contain the host bootstrap (run npm run build first)')
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'bootstrap.js'), 'utf8')
    assert.equal(readFileSync(shipped, 'utf8'), source)
  })
})
