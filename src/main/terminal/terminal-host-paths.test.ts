import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  devTerminalHostSourceDir,
  ensureTerminalHostArtifacts,
  missingTerminalHostArtifacts,
  SHIPPED_TERMINAL_HOST_FILES,
  TERMINAL_HOST_BOOTSTRAP_FILE,
  terminalHostArtifactsComplete
} from './terminal-host-paths'

/**
 * Terminal Host artifact guarantees: the fork entrypoint plus the
 * runtime travel verbatim from the audited source tree into the
 * built main directory (dev self-heal + packaged delivery).
 */
describe('terminal host paths', () => {
  it('declares exactly the shipped bootstrap and runtime', () => {
    assert.deepEqual([...SHIPPED_TERMINAL_HOST_FILES], [
      { src: 'terminal-host-bootstrap.js', dest: 'terminal-host-bootstrap.js' },
      { src: 'terminal-host.mjs', dest: 'terminal-host.mjs' }
    ])
    assert.equal(TERMINAL_HOST_BOOTSTRAP_FILE, 'terminal-host-bootstrap.js')
  })

  it('dev source dir holds the audited host files', () => {
    const live = join(process.cwd(), 'src', 'main', 'terminal')
    for (const file of SHIPPED_TERMINAL_HOST_FILES) {
      assert.ok(existsSync(join(live, file.src)), `dev source dir must hold ${file.src}`)
    }
  })

  it('copy script ships exactly these files and fails closed', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'copy-terminal-host-bootstrap.cjs'), 'utf8')
    assert.ok(script.includes('terminal-host-bootstrap.js'), 'copy script must ship the bootstrap')
    assert.ok(script.includes('terminal-host.mjs'), 'copy script must ship the runtime')
    assert.ok(script.includes('process.exit(1)'), 'copy script must fail the build when a source is missing')
    for (const file of SHIPPED_TERMINAL_HOST_FILES) {
      assert.ok(script.includes(`src: '${file.src}'`), `copy script must list ${file.src}`)
    }
  })

  it('built output carries the forkable artifacts', () => {
    const shipped = join(process.cwd(), 'out', 'main')
    assert.ok(existsSync(join(shipped, 'terminal-host-bootstrap.js')), 'build output must hold the bootstrap')
    assert.ok(existsSync(join(shipped, 'terminal-host.mjs')), 'build output must hold the runtime')
    assert.ok(terminalHostArtifactsComplete(shipped), 'completeness check must pass on built output')
    assert.deepEqual(missingTerminalHostArtifacts(shipped), [])
  })

  it('dev self-heal restores only missing artifacts verbatim', () => {
    const mainDir = mkdtempSync(join(tmpdir(), 'stark-term-host-main-'))
    const sourceDir = mkdtempSync(join(tmpdir(), 'stark-term-host-src-'))
    try {
      writeFileSync(join(sourceDir, 'terminal-host-bootstrap.js'), '// bootstrap')
      writeFileSync(join(sourceDir, 'terminal-host.mjs'), '// runtime')
      assert.deepEqual(missingTerminalHostArtifacts(mainDir), ['terminal-host-bootstrap.js', 'terminal-host.mjs'])
      const copied = ensureTerminalHostArtifacts(mainDir, sourceDir)
      assert.deepEqual([...copied].sort(), ['terminal-host-bootstrap.js', 'terminal-host.mjs'])
      assert.ok(terminalHostArtifactsComplete(mainDir))
      assert.deepEqual(ensureTerminalHostArtifacts(mainDir, sourceDir), [])
    } finally {
      rmSync(mainDir, { recursive: true, force: true })
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  it('dev source helper derives from the app path, never hardcoded', () => {
    assert.equal(
      devTerminalHostSourceDir('/app/approot'),
      join('/app/approot', 'src', 'main', 'terminal')
    )
  })
})
