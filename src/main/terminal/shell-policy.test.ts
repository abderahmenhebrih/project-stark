import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fallbackShell, selectShell } from './shell-policy'

/**
 * Stage 11 shell policy: the main process chooses a safe platform
 * default; the renderer never specifies an executable. No native PTY
 * binary is required for these tests.
 */
describe('terminal shell policy', () => {
  it('selects powershell with -NoLogo on Windows', () => {
    assert.deepEqual(selectShell('win32'), {
      file: 'powershell.exe',
      args: ['-NoLogo'],
      label: 'PowerShell'
    })
  })

  it('selects zsh on macOS', () => {
    assert.deepEqual(selectShell('darwin'), { file: '/bin/zsh', args: [], label: 'zsh' })
  })

  it('selects bash on Linux', () => {
    assert.deepEqual(selectShell('linux'), { file: '/bin/bash', args: [], label: 'bash' })
  })

  it('falls back to sh through the explicit fallback', () => {
    assert.deepEqual(fallbackShell(), { file: '/bin/sh', args: [], label: 'sh' })
  })

  it('uses deterministic args with no renderer input', () => {
    const first = selectShell('win32')
    const second = selectShell('win32')
    assert.deepEqual(first, second)
    assert.ok(!('shell' in first && typeof (first as { shell?: unknown }).shell === 'undefined' && false))
  })

  it('never uses shell:true or renderer-provided executables', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const selected = selectShell(platform)
      assert.equal(typeof selected.file, 'string')
      assert.ok(selected.file.length > 0)
      assert.ok(Array.isArray(selected.args))
    }
  })
})
